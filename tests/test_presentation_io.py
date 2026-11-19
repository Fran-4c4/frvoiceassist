import io
import json
import zipfile

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app import presentation_io as pio
from app.config import Settings
from app.main import create_app
from app.presentations import PresentationData, PresentationItem
from app.tts.fake import FakeEngine
from tests.conftest import FakeTranscriber, make_wav_bytes

VOICE_WAV = make_wav_bytes(5.0)


def add_voice(client, name="me"):
    res = client.post(
        "/api/voices",
        data={"name": name, "transcript": "Hello, this is my voice.", "overwrite": "true"},
        files={"audio": ("me.wav", VOICE_WAV, "audio/wav")},
    )
    assert res.status_code == 201


def new_presentation(client, items, voice="me"):
    res = client.post("/api/presentations", json={"title": "Revisión · Q3", "voice": voice, "items": items})
    assert res.status_code == 201
    return res.json()


def prepare(client, texts, voice="me"):
    for t in texts:
        assert client.post("/api/clips", json={"text": t, "voice": voice}).status_code == 200


ITEMS = [
    {"title": "Slide 1", "text": "Good morning. [pausa] Thanks for joining."},
    {"title": "", "text": "Second block here."},
]
SPOKEN = ["Good morning.", "Thanks for joining.", "Second block here."]


# --------------------------------------------------------------------------- Markdown script


def test_markdown_roundtrip():
    data = PresentationData(
        title="Demo", voice="me", clone_mode="timbre", language="English",
        items=[PresentationItem(title="Intro", text="Hello.\nSecond line."), PresentationItem(title="", text="Bye.")],
    )
    md = pio.to_markdown(data)
    assert md.startswith("<!-- frvoiceassist {")
    assert "# Intro\nHello.\nSecond line.\n" in md
    back = pio.data_from_script(md, "x")
    assert back.title == "Demo" and back.voice == "me" and back.clone_mode == "timbre"
    assert [(i.title, i.text) for i in back.items] == [("Intro", "Hello.\nSecond line."), ("", "Bye.")]


def test_parse_paragraphs_without_titles():
    settings, items = pio.parse_script("First para.\nSame para.\n\n\nSecond para.")
    assert settings == {}
    assert [i.text for i in items] == ["First para.\nSame para.", "Second para."]


def test_parse_empty_script_fails():
    with pytest.raises(pio.ImportError_):
        pio.data_from_script("  \n\n", "x")


def test_api_parse_script(client):
    res = client.post("/api/script/parse", json={"text": "# A\nHello.\n# B\nBye."}).json()
    assert [(i["title"], i["text"]) for i in res["items"]] == [("A", "Hello."), ("B", "Bye.")]
    assert all(i["id"] for i in res["items"])


def test_export_and_import_markdown(client):
    p = new_presentation(client, ITEMS)
    res = client.get(f"/api/presentations/{p['id']}/export.md")
    assert res.status_code == 200
    assert "filename*=UTF-8''Revisi%C3%B3n" in res.headers["content-disposition"]
    assert "# Slide 1\nGood morning. [pausa] Thanks for joining." in res.text
    imported = client.post("/api/presentations/import", files={"file": ("guion.md", res.content, "text/markdown")})
    assert imported.status_code == 201
    q = imported.json()["presentation"]
    assert q["id"] != p["id"] and q["title"] == p["title"] and len(q["items"]) == 2


def test_import_rejects_garbage(client):
    assert client.post("/api/presentations/import", files={"file": ("x.md", b"   ", "text/plain")}).status_code == 422
    bad_zip = client.post("/api/presentations/import", files={"file": ("x.zip", b"PK\x03\x04junk", "application/zip")})
    assert bad_zip.status_code == 422


# --------------------------------------------------------------------------- ZIP archive


def read_zip(content):
    return zipfile.ZipFile(io.BytesIO(content))


def test_export_zip_complete(client):
    add_voice(client)
    p = new_presentation(client, ITEMS)
    prepare(client, SPOKEN)
    res = client.get(f"/api/presentations/{p['id']}/export.zip")
    assert res.status_code == 200 and res.headers["x-missing-clips"] == "0"
    zf = read_zip(res.content)
    names = set(zf.namelist())
    assert {"presentation.json", "guion.md", "manifest.json", "presentacion_completa.wav"} <= names
    assert len([n for n in names if n.startswith("clips/")]) == 3
    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["missing"] == [] and len(manifest["clips"]) == 3
    full, sr = sf.read(io.BytesIO(zf.read("presentacion_completa.wav")))
    clips_s = sum(sf.info(io.BytesIO(zf.read(c["file"]))).duration for c in manifest["clips"])
    # 3 clips + 1 pause between sentences (0.25 s) + 1 pause between blocks (1 s)
    assert abs(len(full) / sr - (clips_s + 0.25 + 1.0)) < 0.01


def test_export_zip_with_missing_clips(client):
    add_voice(client)
    p = new_presentation(client, ITEMS)
    prepare(client, SPOKEN[:1])
    res = client.get(f"/api/presentations/{p['id']}/export.zip")
    assert res.headers["x-missing-clips"] == "2"
    assert "presentacion_completa.wav" not in read_zip(res.content).namelist()


def test_zip_import_restores_audio_on_another_machine(client, tmp_path):
    add_voice(client)
    p = new_presentation(client, ITEMS)
    prepare(client, SPOKEN)
    exported = client.get(f"/api/presentations/{p['id']}/export.zip").content

    # "Another computer": a different data directory with the same voice content
    other = Settings(engine="fake", workspace_dir=tmp_path / "other", quality_stt="none")
    engine = FakeEngine()
    with TestClient(create_app(other, engine, FakeTranscriber())) as c2:
        add_voice(c2)
        res = c2.post("/api/presentations/import", files={"file": ("p.zip", exported, "application/zip")})
        assert res.status_code == 201 and res.json()["imported_clips"] == 3
        lookup = c2.post("/api/clips/lookup", json={"texts": SPOKEN, "voice": "me"}).json()
        assert all(info and info["cached"] for info in lookup)
        assert engine.calls == []  # nothing was generated again


def test_zip_import_ignores_unsafe_paths(client, settings):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("guion.md", "# A\nHello.")
        zf.writestr("../evil.wav", b"x")
        zf.writestr("clips/../../evil2.wav", b"x")
        zf.writestr("clips/notahash.wav", b"x")
    res = client.post("/api/presentations/import", files={"file": ("p.zip", buffer.getvalue(), "application/zip")})
    assert res.status_code == 201 and res.json()["imported_clips"] == 0
    assert not list(settings.workspace_dir.parent.rglob("evil*.wav"))


# --------------------------------------------------------------------------- Delete blocks and audio


def clip_files(settings):
    return sorted(p.stem for p in settings.clips_dir.glob("*.wav"))


def test_delete_item_removes_its_audio_but_keeps_shared(client, settings):
    add_voice(client)
    items = [
        {"title": "A", "text": "Shared sentence. Only in A."},
        {"title": "B", "text": "Shared sentence. Only in B."},
    ]
    p = new_presentation(client, items)
    prepare(client, ["Shared sentence.", "Only in A.", "Only in B."])
    assert len(clip_files(settings)) == 3
    item_a = p["items"][0]["id"]
    res = client.delete(f"/api/presentations/{p['id']}/items/{item_a}")
    assert res.status_code == 200
    body = res.json()
    assert body["deleted_clips"] == 1  # "Only in A."; B still uses "Shared sentence."
    assert [i["title"] for i in body["presentation"]["items"]] == ["B"]
    assert len(clip_files(settings)) == 2
    assert client.delete(f"/api/presentations/{p['id']}/items/{item_a}").status_code == 404


def test_audio_shared_with_another_presentation_is_kept(client, settings):
    add_voice(client)
    p1 = new_presentation(client, [{"title": "", "text": "Common line."}])
    new_presentation(client, [{"title": "", "text": "Common line."}])
    prepare(client, ["Common line."])
    client.delete(f"/api/presentations/{p1['id']}/items/{p1['items'][0]['id']}")
    assert len(clip_files(settings)) == 1


def test_delete_presentation_removes_its_audio(client, settings):
    add_voice(client)
    p = new_presentation(client, ITEMS)
    prepare(client, SPOKEN)
    assert client.delete(f"/api/presentations/{p['id']}").status_code == 204
    assert clip_files(settings) == []


def test_cleanup_removes_orphans(client, settings):
    add_voice(client)
    new_presentation(client, [{"title": "", "text": "Kept."}])
    prepare(client, ["Kept.", "Orphan one.", "Orphan two."])
    res = client.post("/api/clips/cleanup").json()
    assert res["deleted"] == 2
    assert len(clip_files(settings)) == 1


def test_release_only_deletes_unused_clips(client, settings):
    add_voice(client)
    new_presentation(client, [{"title": "", "text": "Still used."}])
    used = client.post("/api/clips", json={"text": "Still used.", "voice": "me"}).json()["key"]
    old = client.post("/api/clips", json={"text": "Edited away.", "voice": "me"}).json()["key"]
    res = client.post("/api/clips/release", json={"keys": [used, old, "../../etc/passwd"]}).json()
    assert res["deleted"] == 1
    assert clip_files(settings) == [used]


def test_voice_fingerprint_survives_copy(tmp_path):
    from app.voices import VoiceStore

    a = VoiceStore(tmp_path / "a").create("me", VOICE_WAV, "me.wav", "Hello.")
    b = VoiceStore(tmp_path / "b").create("me", VOICE_WAV, "me.wav", "Hello.")
    assert a.fingerprint == b.fingerprint
    c = VoiceStore(tmp_path / "c").create("me", VOICE_WAV, "me.wav", "Other text.")
    assert c.fingerprint != a.fingerprint
