def test_clip_is_generated_once_and_then_cached(client, voice_me, engine, settings):
    first = client.post("/api/clips", json={"text": "Hello there.", "voice": "me"})
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["cached"] is False and data["duration_s"] > 0
    assert (settings.clips_dir / f"{data['key']}.wav").is_file()
    assert client.get(data["url"]).status_code == 200

    calls = len(engine.calls)
    again = client.post("/api/clips", json={"text": "  Hello   there. ", "voice": "me"}).json()
    assert again["cached"] is True and again["key"] == data["key"]
    assert len(engine.calls) == calls  # it is not generated again
    # Clips are not saved as output files
    assert not any(settings.outputs_dir.iterdir())


def test_clip_key_depends_on_mode_and_language(client, voice_me):
    a = client.post("/api/clips", json={"text": "Hi.", "voice": "me"}).json()["key"]
    b = client.post("/api/clips", json={"text": "Hi.", "voice": "me", "clone_mode": "timbre"}).json()["key"]
    c = client.post("/api/clips", json={"text": "Hi.", "voice": "me", "language": "Spanish"}).json()["key"]
    assert len({a, b, c}) == 3


def test_clip_cache_invalidated_when_voice_changes(client, voice_me):
    from tests.conftest import make_wav_bytes

    a = client.post("/api/clips", json={"text": "Hi.", "voice": "me"}).json()["key"]
    client.post(
        "/api/voices",
        data={"name": "me", "transcript": "Another transcript.", "overwrite": "true"},
        files={"audio": ("me.wav", make_wav_bytes(6.0), "audio/wav")},
    )
    b = client.post("/api/clips", json={"text": "Hi.", "voice": "me"}).json()["key"]
    assert a != b


def test_lookup_does_not_generate(client, voice_me, engine):
    client.post("/api/clips", json={"text": "Ready one.", "voice": "me"})
    calls = len(engine.calls)
    res = client.post("/api/clips/lookup", json={"texts": ["Ready one.", "Not yet.", "  "], "voice": "me"})
    assert res.status_code == 200
    ready, missing, empty = res.json()
    assert ready["cached"] is True
    assert missing is None and empty is None
    assert len(engine.calls) == calls


def test_clip_errors(client, voice_me):
    assert client.post("/api/clips", json={"text": "Hi.", "voice": "nobody"}).status_code == 404
    assert client.post("/api/clips", json={"text": ""}).status_code == 422
    assert client.post("/api/clips/lookup", json={"texts": ["Hi."], "voice": "nobody"}).status_code == 404
