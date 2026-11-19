import io

import soundfile as sf

from tests.conftest import make_wav_bytes


def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ready"
    assert body["engine"] == "fake"


def test_index_and_static(client):
    assert "frvoiceassist" in client.get("/").text
    assert client.get("/static/app.js").status_code == 200


def test_reference_script(client):
    assert "Hello" in client.get("/api/reference-script").text
    assert "Hola" in client.get("/api/reference-script?lang=es").text
    assert client.get("/api/reference-script?lang=fr").status_code == 422


def test_voice_creation_includes_quality_report(voice_me, transcriber):
    quality = voice_me["quality"]
    assert transcriber.calls == 1
    assert quality["word_match"] == 1.0
    assert quality["transcription"] == "Hello, this is my voice."
    assert quality["detected_language"] == "en"
    assert quality["metrics"]["duration_s"] == 5.0
    assert quality["verdict"] in {"ok", "warn", "bad"}


def test_quality_report_is_listed_and_recheckable(client, voice_me, transcriber):
    assert client.get("/api/voices").json()[0]["quality"]["word_match"] == 1.0
    transcriber.text = "Something completely different was said here."
    report = client.post("/api/voices/me/check").json()
    assert report["verdict"] == "bad"
    assert report["word_match"] < 0.8
    assert client.post("/api/voices/nobody/check").status_code == 404


def test_tts_timbre_mode(client, voice_me, engine):
    assert client.post("/api/tts", json={"text": "Hi.", "clone_mode": "timbre"}).status_code == 200
    assert engine.calls[-1][3] is True
    assert client.post("/api/tts", json={"text": "Hi.", "clone_mode": "bogus"}).status_code == 422


def test_languages(client):
    assert "English" in client.get("/api/languages").json()


def test_voice_crud(client, voice_me):
    assert voice_me["name"] == "me"
    assert [v["name"] for v in client.get("/api/voices").json()] == ["me"]
    audio = client.get("/api/voices/me/audio")
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/wav"
    assert client.delete("/api/voices/me").status_code == 204
    assert client.get("/api/voices").json() == []
    assert client.delete("/api/voices/me").status_code == 404


def test_voice_validation_error(client):
    res = client.post(
        "/api/voices",
        data={"name": "me", "transcript": "hi"},
        files={"audio": ("me.wav", make_wav_bytes(0.5), "audio/wav")},
    )
    assert res.status_code == 422
    assert "corto" in res.json()["detail"]


def test_tts_returns_wav_and_saves_output(client, voice_me, settings, engine):
    text = "Hello everyone. Welcome to the presentation. " * 4
    res = client.post("/api/tts", json={"text": text, "voice": "me"})
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "audio/wav"
    data, sr = sf.read(io.BytesIO(res.content))
    assert sr == 24_000 and data.size > 0
    assert int(res.headers["X-Chunks"]) > 1  # chunk_chars=60 in the fixture
    assert all(lang == "English" and voice == "me" and not timbre for _, lang, voice, timbre in engine.calls)
    output = settings.outputs_dir / res.headers["X-Output-File"]
    assert output.is_file()
    assert client.get(f"/outputs/{output.name}").status_code == 200


def test_tts_uses_default_voice(client, voice_me):
    assert client.post("/api/tts", json={"text": "Hi."}).status_code == 200


def test_tts_unknown_voice(client):
    res = client.post("/api/tts", json={"text": "Hi.", "voice": "nobody"})
    assert res.status_code == 404


def test_tts_empty_text(client, voice_me):
    assert client.post("/api/tts", json={"text": ""}).status_code == 422
    assert client.post("/api/tts", json={"text": "   "}).status_code == 422


def test_tts_too_long(client, voice_me):
    assert client.post("/api/tts", json={"text": "a" * 501}).status_code == 413


def test_tts_bad_language(client, voice_me):
    assert client.post("/api/tts", json={"text": "Hi.", "language": "Klingon"}).status_code == 422


def test_tts_engine_not_ready(settings, voice_me):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.tts.qwen import QwenEngine

    engine = QwenEngine(settings)
    engine.load = lambda: None  # simulate "still loading" without importing torch
    with TestClient(create_app(settings, engine)) as c:
        assert c.get("/api/health").json()["status"] == "loading"
        assert c.post("/api/tts", json={"text": "Hi."}).status_code == 503
