import pytest
from hypothesis import given
from hypothesis import strategies as st

from stylus.config import ReaderConfig
from stylus.events import is_curator_uri
from stylus.state_machine import (
    BadTag,
    DetectionMachine,
    Start,
    State,
    Stop,
    Swap,
    TagRead,
)

CFG = ReaderConfig(insertion_debounce_polls=2, removal_debounce_polls=3, swap_debounce_polls=1)
URI_A = "curator:album:aaaa1111"
URI_B = "curator:album:bbbb2222"


def feed(m: DetectionMachine, seq):
    return [m.observe(obs) for obs in seq]


def test_insertion_fires_start_only_after_debounce():
    m = DetectionMachine(CFG)
    tag = TagRead("A", URI_A)
    assert m.observe(tag) is None  # 1st positive read — not yet
    action = m.observe(tag)  # 2nd → threshold
    assert action == Start(uid="A", uri=URI_A)
    assert m.state is State.PLAYING and m.current_uri == URI_A
    assert m.observe(tag) is None  # already playing, no re-fire


def test_ghost_read_below_debounce_never_fires():
    m = DetectionMachine(CFG)
    assert m.observe(TagRead("A", URI_A)) is None
    assert m.observe(None) is None  # tag gone before debounce met
    assert m.state is State.IDLE


def test_bad_tag_flagged_once_no_start():
    m = DetectionMachine(CFG)
    bad = TagRead("A", "spotify:album:xxxx")  # not a curator album URI
    assert m.observe(bad) is None
    assert m.observe(bad) == BadTag(uid="A")  # flagged at threshold
    assert m.observe(bad) is None  # not re-flagged while it sits there
    assert m.state is State.IDLE


def test_removal_fires_stop_after_debounce():
    m = DetectionMachine(CFG)
    m.observe(TagRead("A", URI_A))
    m.observe(TagRead("A", URI_A))  # → PLAYING
    assert m.observe(None) is None
    assert m.observe(None) is None
    assert m.observe(None) == Stop()  # 3rd miss = removal_debounce_polls
    assert m.state is State.IDLE and m.current_uid is None


def test_brief_dropout_does_not_stop():
    m = DetectionMachine(CFG)
    m.observe(TagRead("A", URI_A))
    m.observe(TagRead("A", URI_A))  # PLAYING
    m.observe(None)
    m.observe(None)
    assert m.observe(TagRead("A", URI_A)) is None  # reappears → removal countdown resets
    assert m.observe(None) is None  # count restarts
    assert m.observe(None) is None
    assert m.observe(None) == Stop()


def test_swap_to_a_different_album():
    m = DetectionMachine(CFG)
    m.observe(TagRead("A", URI_A))
    m.observe(TagRead("A", URI_A))  # PLAYING A
    action = m.observe(TagRead("B", URI_B))  # swap_debounce_polls == 1
    assert action == Swap(uid="B", uri=URI_B)
    assert m.current_uid == "B" and m.current_uri == URI_B
    assert m.state is State.PLAYING


def test_unreadable_different_tag_is_ignored_while_playing():
    m = DetectionMachine(CFG)
    m.observe(TagRead("A", URI_A))
    m.observe(TagRead("A", URI_A))  # PLAYING A
    assert m.observe(TagRead("B", None)) is None  # can't read B → keep A
    assert m.current_uid == "A"


def test_stop_then_reinsert_same_album_fires_again():
    m = DetectionMachine(CFG)
    m.observe(TagRead("A", URI_A))
    m.observe(TagRead("A", URI_A))
    for _ in range(3):
        m.observe(None)  # → Stop → IDLE
    assert m.state is State.IDLE
    m.observe(TagRead("A", URI_A))
    assert m.observe(TagRead("A", URI_A)) == Start(uid="A", uri=URI_A)


# --- issue #198: a failed decode must not latch a sleeve off ------------------------------------
#
# The reader re-reads NDEF on every poll of an undecoded tag (misses are deliberately not cached,
# #176), so a decode that fails while the sleeve is still settling recovers on a later poll. The
# machine has to still be looking when it does.


def test_a_decode_that_fails_at_the_threshold_still_fires_once_it_recovers():
    """The reported bug: two failed decodes, then a good one, and the sleeve never fired.

    On real hardware the deciding poll lands ~400ms after first detection — while the sleeve is
    being lowered and the multi-page I²C read is marginal. The reader recovered on every later
    poll; the machine had stopped looking.
    """
    m = DetectionMachine(CFG)
    assert m.observe(TagRead("A", None)) is None  # poll 1: present, undecoded
    assert m.observe(TagRead("A", None)) == BadTag(uid="A")  # poll 2: threshold, still undecoded
    # From here the reader decodes perfectly. The machine must act on that.
    assert m.observe(TagRead("A", URI_A)) == Start(uid="A", uri=URI_A)
    assert m.state is State.PLAYING and m.current_uri == URI_A


def test_it_does_not_take_lifting_the_sleeve_to_recover():
    """The workaround that made this look intermittent rather than broken."""
    m = DetectionMachine(CFG)
    m.observe(TagRead("A", None))
    m.observe(TagRead("A", None))
    # Ten more polls of a now-readable tag, without ever leaving the field.
    actions = [m.observe(TagRead("A", URI_A)) for _ in range(10)]
    assert actions[0] == Start(uid="A", uri=URI_A)
    assert all(a is None for a in actions[1:])  # fires once, not per poll


@pytest.mark.parametrize("threshold", [1, 2, 3, 5])
@pytest.mark.parametrize("misses", [0, 1, 2, 5, 12])
def test_any_number_of_failed_decodes_before_a_good_one_still_fires(threshold, misses):
    """The family: no combination of debounce and early misses may strand a readable tag."""
    cfg = ReaderConfig(insertion_debounce_polls=threshold)
    m = DetectionMachine(cfg)
    for _ in range(misses):
        m.observe(TagRead("A", None))
    # However long it took to become readable, `threshold` good polls must start it.
    actions = [m.observe(TagRead("A", URI_A)) for _ in range(threshold)]
    assert m.state is State.PLAYING, f"latched off after {misses} misses at threshold {threshold}"
    assert Start(uid="A", uri=URI_A) in actions


def test_a_flaky_swap_still_swaps_once_the_new_sleeve_reads():
    """The sibling path: PLAYING already re-checks every poll, so it recovers. Pinned so it stays that way."""
    m = DetectionMachine(CFG)
    m.observe(TagRead("A", URI_A))
    m.observe(TagRead("A", URI_A))  # PLAYING A
    assert m.observe(TagRead("B", None)) is None  # B present but undecoded — keep playing A
    assert m.current_uid == "A"
    assert m.observe(TagRead("B", URI_B)) == Swap(uid="B", uri=URI_B)
    assert m.current_uid == "B" and m.current_uri == URI_B


# --- property test: replay arbitrary observation streams, invariants must always hold -----------
_UIDS = ["A", "B", "C"]
_URIS = [URI_A, URI_B, "curator:album:cccc3333", "curator:card:dddd4444", "spotify:bad", None]


@st.composite
def _observation(draw):
    if draw(st.booleans()):
        return None
    uid = draw(st.sampled_from(_UIDS))
    uri = draw(st.sampled_from(_URIS))
    return TagRead(uid, uri)


@given(st.lists(_observation(), max_size=60))
def test_invariants_hold_over_any_stream(seq):
    m = DetectionMachine(CFG)
    for obs in seq:
        action = m.observe(obs)
        # State/field coherence.
        assert (m.state is State.PLAYING) == (m.current_uid is not None)
        if m.state is State.PLAYING:
            assert is_curator_uri(m.current_uri)
        # Actions are only ever emitted in states that make sense, always with a valid URI.
        if isinstance(action, (Start, Swap)):
            assert is_curator_uri(action.uri)
            assert m.state is State.PLAYING and m.current_uri == action.uri
        elif isinstance(action, Stop):
            assert m.state is State.IDLE and m.current_uid is None
        elif isinstance(action, BadTag):
            assert m.state is State.IDLE


# --- the blind spot (issue #198): liveness, not just safety -------------------------------------
#
# Every invariant above is a *safety* property — "the machine never does the wrong thing". Issue
# #198 was a *liveness* failure: the machine did nothing at all, forever, which satisfies every
# safety assertion trivially. That is precisely why a full property suite stayed green while a
# sleeve on the stand was dead.
#
# This is the guard that now catches the whole family: whatever noise comes first, a readable tag
# that stays put must eventually play.


@given(
    noise=st.lists(st.sampled_from(["absent", "undecoded", "bad"]), max_size=25),
    threshold=st.integers(min_value=1, max_value=6),
)
def test_a_stable_readable_tag_always_ends_up_playing(noise, threshold):
    m = DetectionMachine(ReaderConfig(insertion_debounce_polls=threshold))
    # Any prelude of no-tag / present-but-undecoded / present-but-not-a-curator-URI polls.
    for kind in noise:
        m.observe(
            None
            if kind == "absent"
            else TagRead("A", None)
            if kind == "undecoded"
            else TagRead("A", "spotify:album:nope")
        )
    # Then the sleeve settles and reads cleanly, held for the full debounce.
    for _ in range(threshold):
        m.observe(TagRead("A", URI_A))
    assert m.state is State.PLAYING, f"stranded after {noise!r} at threshold {threshold}"
    assert m.current_uri == URI_A


@given(
    misses=st.integers(min_value=0, max_value=20),
    threshold=st.integers(min_value=1, max_value=6),
)
def test_a_swap_to_a_readable_sleeve_always_lands(misses, threshold):
    """The same liveness guarantee for the PLAYING path, which has its own debounce."""
    m = DetectionMachine(ReaderConfig(insertion_debounce_polls=1, swap_debounce_polls=threshold))
    m.observe(TagRead("A", URI_A))
    assert m.state is State.PLAYING
    for _ in range(misses):
        m.observe(TagRead("B", None))  # B is there but won't decode yet
    for _ in range(threshold):
        m.observe(TagRead("B", URI_B))
    assert m.current_uid == "B" and m.current_uri == URI_B
