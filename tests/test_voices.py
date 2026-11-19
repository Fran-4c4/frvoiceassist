import pytest
import soundfile as sf

from app.voices import AUDIO_FILE, VoiceError, VoiceStore
from tests.conftest import make_wav_bytes


@pytest.fixture
def store(tmp_path):
    return VoiceStore(tmp_path / "voices")


def test_create_list_get_delete(store):
    profile = store.create("me", make_wav_bytes(5.0, channels=2), "me.wav", "  Hello   world. ")
    assert profile.name == "me"
    assert profile.transcript == "Hello world."
    assert 4.9 < profile.duration_s < 5.1
    assert sf.info(str(profile.audio_path)).channels == 1
    assert [v.name for v in store.list()] == ["me"]
    assert store.get("me").audio_path.name == AUDIO_FILE
    store.delete("me")
    assert store.list() == []
    with pytest.raises(KeyError):
        store.get("me")


@pytest.mark.parametrize("name", ["", "Me With Spaces", "../etc", "-bad", "x" * 41])
def test_invalid_names(store, name):
    with pytest.raises(VoiceError):
        store.create(name, make_wav_bytes(5.0), "a.wav", "text")


def test_name_is_lowercased(store):
    assert store.create("Alice", make_wav_bytes(5.0), "a.wav", "text").name == "alice"


def test_requires_transcript(store):
    with pytest.raises(VoiceError, match="transcripción"):
        store.create("me", make_wav_bytes(5.0), "a.wav", "   ")


def test_rejects_too_short_and_cleans_up(store):
    with pytest.raises(VoiceError, match="corto"):
        store.create("me", make_wav_bytes(1.0), "a.wav", "text")
    assert store.list() == []
    assert not any(store.root.iterdir())


def test_rejects_too_long(store):
    with pytest.raises(VoiceError, match="largo"):
        store.create("me", make_wav_bytes(61.0, sample_rate=8000), "a.wav", "text")


def test_rejects_garbage_audio(store):
    with pytest.raises(VoiceError):
        store.create("me", b"not audio at all", "a.wav", "text")


def test_overwrite(store):
    store.create("me", make_wav_bytes(5.0), "a.wav", "first")
    with pytest.raises(VoiceError, match="Ya existe"):
        store.create("me", make_wav_bytes(5.0), "a.wav", "second")
    assert store.create("me", make_wav_bytes(6.0), "a.wav", "second", overwrite=True).transcript == "second"


def test_get_rejects_path_traversal(store):
    with pytest.raises(KeyError):
        store.get("../../secret")
