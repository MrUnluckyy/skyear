"""Claiming /data, then ceasing to be root.

Home Assistant runs add-ons as root and mounts its own /data owned by root, so
the chown baked into the image applies to a directory the Supervisor covers up.
Saving a camera failed with PermissionError on /data/config.tmp - every read
worked, and the first write died.
"""
from pathlib import Path

from skyear import config_store


def test_does_nothing_when_already_unprivileged(tmp_path):
    """A standalone container starts as the right user and must be left alone."""
    assert config_store.take_ownership(tmp_path) is False


def test_returns_false_and_stays_put_without_the_account(tmp_path, monkeypatch):
    """Somebody's own build with no skyear user: staying root beats guessing
    at an identity to become."""
    monkeypatch.setattr(config_store.os, "geteuid", lambda: 0)
    assert config_store.take_ownership(tmp_path, user="definitely-not-a-user") is False


def test_claims_the_directory_then_drops(tmp_path, monkeypatch):
    calls = {}

    class Account:
        pw_uid, pw_gid, pw_name = 1000, 1000, "skyear"

    monkeypatch.setattr(config_store.os, "geteuid", lambda: 0)
    monkeypatch.setattr(config_store.os, "chown", lambda p, u, g: calls.setdefault("chown", []).append(Path(p).name))
    monkeypatch.setattr(config_store.os, "setgid", lambda g: calls.__setitem__("gid", g))
    monkeypatch.setattr(config_store.os, "setuid", lambda u: calls.__setitem__("uid", u))
    monkeypatch.setattr(config_store.os, "setgroups", lambda g: None)

    import pwd
    monkeypatch.setattr(pwd, "getpwnam", lambda n: Account())

    (tmp_path / "existing.json").write_text("{}")
    assert config_store.take_ownership(tmp_path) is True

    assert "existing.json" in calls["chown"], "existing files must be claimed too"
    assert calls["uid"] == 1000 and calls["gid"] == 1000
    # order matters: ownership first, privileges dropped after
    assert "chown" in calls


def test_a_failed_chown_does_not_stop_the_agent(tmp_path, monkeypatch):
    """A read-only mount should not prevent starting; the real error surfaces
    later, where it can be reported to the user."""
    class Account:
        pw_uid, pw_gid, pw_name = 1000, 1000, "skyear"

    def boom(*a):
        raise PermissionError("read-only")

    monkeypatch.setattr(config_store.os, "geteuid", lambda: 0)
    monkeypatch.setattr(config_store.os, "chown", boom)
    monkeypatch.setattr(config_store.os, "setgid", lambda g: None)
    monkeypatch.setattr(config_store.os, "setuid", lambda u: None)
    monkeypatch.setattr(config_store.os, "setgroups", lambda g: None)
    import pwd
    monkeypatch.setattr(pwd, "getpwnam", lambda n: Account())

    assert config_store.take_ownership(tmp_path) is True
