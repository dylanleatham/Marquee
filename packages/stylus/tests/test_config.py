import tomllib

import pytest

from stylus.config import Config, ReaderConfig, config_from_dict, load_config


def test_defaults_with_empty_dict():
    c = config_from_dict({})
    assert c.reader == ReaderConfig()
    assert c.reader.poll_interval_ms == 200
    assert c.reader.insertion_debounce_polls == 2
    assert c.reader.removal_debounce_polls == 10
    assert c.downstreams == ()
    assert c.status_listen_port == 4741
    assert c.led.gpio_pin == 17 and c.led.enabled is True


def test_reads_downstreams_in_fanout_order():
    c = config_from_dict(
        {
            "downstream": {
                "conductor": {"url": "http://c:4737/api/scan", "shared_secret": "s1"},
                "backdrop": {"url": "http://b:4740/api/scan", "timeout_ms": 500},
            }
        }
    )
    assert [d.name for d in c.downstreams] == ["conductor", "backdrop"]
    assert c.downstreams[0].shared_secret == "s1"
    assert c.downstreams[1].timeout_ms == 500


def test_player_is_a_legacy_alias_for_backdrop():
    c = config_from_dict({"downstream": {"player": {"url": "http://b:4740/api/scan"}}})
    assert [d.name for d in c.downstreams] == ["backdrop"]


def test_explicit_backdrop_wins_over_legacy_player():
    c = config_from_dict(
        {
            "downstream": {
                "backdrop": {"url": "http://new:4740/api/scan"},
                "player": {"url": "http://old:4740/api/scan"},
            }
        }
    )
    assert [d.name for d in c.downstreams] == ["backdrop"]
    assert c.downstreams[0].url == "http://new:4740/api/scan"


def test_downstream_without_url_is_an_error():
    with pytest.raises(ValueError, match="no url"):
        config_from_dict({"downstream": {"conductor": {"shared_secret": "x"}}})


@pytest.mark.parametrize(
    "field", ["poll_interval_ms", "insertion_debounce_polls", "removal_debounce_polls"]
)
def test_rejects_sub_one_tuning(field):
    with pytest.raises(ValueError):
        config_from_dict({"reader": {field: 0}})


def test_load_config_from_file(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text(
        '[reader]\nid = "kitchen"\npoll_interval_ms = 150\n'
        '[downstream.conductor]\nurl = "http://c:4737/api/scan"\n'
        "[status]\nlisten_port = 5000\n"
    )
    c = load_config(p)
    assert c.reader.id == "kitchen"
    assert c.reader.poll_interval_ms == 150
    assert c.status_listen_port == 5000
    assert c.downstreams[0].url == "http://c:4737/api/scan"


def test_example_config_parses():
    # The shipped example must always be loadable (it's what an operator copies to the Pi).
    from pathlib import Path

    example = Path(__file__).resolve().parents[1] / "config.example.toml"
    raw = tomllib.loads(example.read_text())
    c = config_from_dict(raw)
    assert isinstance(c, Config)
    assert {d.name for d in c.downstreams} == {"conductor", "backdrop"}
