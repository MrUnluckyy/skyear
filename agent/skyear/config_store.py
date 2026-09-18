"""Device-local configuration written by the setup UI.

The agent originally required a hand-edited config.yaml, which meant SSH, a
text editor and YAML syntax before anything worked. This stores the same
settings as JSON in the data directory so a browser form can write them.

config.yaml still wins if it exists, so existing installs are untouched.

The camera secret lives here at mode 0600, exactly as it did in .env. That
protects it from other users on the box and from a careless backup; it is not
protection against someone who already has root, and pretending otherwise with
a locally-stored encryption key would be theatre. The property that matters is
unchanged: it never leaves the device.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
from pathlib import Path

log = logging.getLogger("config")

FILENAME = "config.json"


def path_for(data_dir: Path) -> Path:
    return Path(data_dir) / FILENAME


def take_ownership(data_dir: Path, user: str = "skyear") -> bool:
    """Claim the data directory, then stop being root.

    Home Assistant mounts its own /data owned by root, so the chown baked into
    the image applies to a directory the Supervisor immediately covers up. The
    agent therefore starts as root, takes the mounted directory, and drops to
    the unprivileged user - ending in exactly the same place as a standalone
    container, which starts unprivileged and never needs this.

    Returns True if privileges were dropped.
    """
    if os.geteuid() != 0:
        return False

    import grp
    import pwd

    try:
        account = pwd.getpwnam(user)
    except KeyError:
        # Somebody's own build without our user. Leave it alone rather than
        # guessing at an identity to become.
        log.warning("running as root: no %s account to drop to", user)
        return False

    data_dir = Path(data_dir)
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        for path in (data_dir, *data_dir.rglob("*")):
            os.chown(path, account.pw_uid, account.pw_gid)
    except OSError as e:
        log.warning("could not take ownership of %s: %s", data_dir, e)

    try:
        os.setgroups(
            [g.gr_gid for g in grp.getgrall() if account.pw_name in g.gr_mem]
        )
    except OSError:
        pass
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    log.info("dropped privileges to %s", user)
    return True


def load(data_dir: Path) -> dict:
    p = path_for(data_dir)
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError) as e:
        log.error("could not read %s: %s", p, e)
        return {}


def save(data_dir: Path, cfg: dict) -> None:
    """Write atomically at 0600 - it holds a camera password."""
    p = path_for(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=1))
    os.chmod(tmp, 0o600)
    tmp.replace(p)


def setup_token(data_dir: Path) -> str:
    """Token guarding the setup UI once a camera is configured.

    While unconfigured the UI is open on the local network, the way a new
    router or NAS is: there is nothing to protect yet, and requiring a token
    read from a log file would defeat the point of having a UI. Once a camera
    is saved there is a password behind it, so the token starts being required.
    """
    p = Path(data_dir) / "setup_token"
    if p.is_file():
        return p.read_text().strip()
    token = secrets.token_urlsafe(18)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(token)
    os.chmod(p, 0o600)
    return token


def is_configured(data_dir: Path) -> bool:
    return bool(load(data_dir).get("cameras"))


def to_agent_config(stored: dict, base: dict | None = None) -> dict:
    """Merge stored settings into the shape the rest of the agent expects."""
    cfg = dict(base or {})
    if stored.get("cameras"):
        cfg["cameras"] = stored["cameras"]
    for section in ("adsb", "detector", "matching", "clips", "cloud"):
        if stored.get(section):
            cfg[section] = {**cfg.get(section, {}), **stored[section]}
    return cfg


def secrets_from(stored: dict) -> dict:
    """Camera secrets, keyed by the env var name the camera config refers to.

    Keeping them in the same shape as .env means build_url and the rest of the
    agent need no special case for UI-configured cameras.
    """
    return {k: v for k, v in (stored.get("secrets") or {}).items() if v}
