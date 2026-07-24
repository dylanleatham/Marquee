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
