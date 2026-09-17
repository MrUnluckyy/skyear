"""Local runs must read .env the way docker-compose's env_file does."""
import os
from pathlib import Path

import pytest

from skyear.main import load_env_file


@pytest.fixture
def clean_env():
    saved = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(saved)


def write(tmp_path, text):
    p = tmp_path / ".env"
    p.write_text(text)
    return p


def test_loads_key_value_pairs(tmp_path, clean_env):
    load_env_file(write(tmp_path, "CAM1_PASSWORD=s3cret\nCAM2_PASSWORD=other\n"))
    assert os.environ["CAM1_PASSWORD"] == "s3cret"
    assert os.environ["CAM2_PASSWORD"] == "other"


def test_ignores_comments_and_blank_lines(tmp_path, clean_env):
    load_env_file(write(tmp_path, "# a comment\n\n  \nCAM1_PASSWORD=ok\n"))
    assert os.environ["CAM1_PASSWORD"] == "ok"


def test_strips_surrounding_quotes(tmp_path, clean_env):
    load_env_file(write(tmp_path, "A='single'\nB=\"double\"\nC=bare\n"))
    assert os.environ["A"] == "single"
    assert os.environ["B"] == "double"
    assert os.environ["C"] == "bare"


def test_password_containing_equals_and_specials_survives(tmp_path, clean_env):
    load_env_file(write(tmp_path, "CAM1_PASSWORD=p@ss=w0rd/+#1\n"))
    assert os.environ["CAM1_PASSWORD"] == "p@ss=w0rd/+#1"


def test_existing_environment_wins(tmp_path, clean_env):
    """In Docker the variable is already set; the file must not override it."""
    os.environ["CAM1_PASSWORD"] = "from-compose"
    load_env_file(write(tmp_path, "CAM1_PASSWORD=from-file\n"))
    assert os.environ["CAM1_PASSWORD"] == "from-compose"


def test_missing_file_is_not_an_error(tmp_path, clean_env):
    load_env_file(tmp_path / "does-not-exist")  # must not raise


def test_directory_path_is_not_an_error(tmp_path, clean_env):
    load_env_file(tmp_path)  # is_file() guards against this


def test_password_is_scrubbed_from_ffprobe_output():
    """ffmpeg echoes the RTSP URL on failure; the password must never survive."""
    from urllib.parse import quote

    from skyear.main import _scrub

    pw = "p@ss w0rd/+"
    err = (f"rtsp://admin:{quote(pw, safe='')}@192.168.1.88:554/Preview_01_sub: "
           f"401 Unauthorized (raw {pw})")
    out = _scrub(err, pw)
    assert pw not in out
    assert quote(pw, safe="") not in out
    assert "***" in out
    assert "192.168.1.88" in out   # the useful part survives


def test_scrub_is_a_noop_without_a_secret():
    from skyear.main import _scrub
    assert _scrub("no audio stream", "") == "no audio stream"
