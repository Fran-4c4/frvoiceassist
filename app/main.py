"""FastAPI API and web interface.

Start with: uvicorn app.main:main_app --factory --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
import re
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import __version__
from app import presentation_io as pio
from app.config import Settings
from app.presentations import Presentation, PresentationData, PresentationStore
from app.quality import Transcriber, WhisperTranscriber, check_reference
from app.service import SUPPORTED_LANGUAGES, SpeechService, TextTooLong
from app.tts import EngineNotReady, TTSEngine, build_engine
from app.voices import VoiceError, VoiceProfile, VoiceStore

log = logging.getLogger("frvoiceassist")
STATIC_DIR = Path(__file__).parent / "static"
RESOURCES_DIR = Path(__file__).parent / "resources"


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: str | None = None
    language: str | None = None
    # full: reference timbre, accent, and rhythm; timbre: speaker timbre only (speaker embedding)
    clone_mode: Literal["full", "timbre"] = "full"


class ClipRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    voice: str | None = None
    language: str | None = None
    clone_mode: Literal["full", "timbre"] = "full"


class ClipLookupRequest(BaseModel):
    texts: list[str] = Field(..., max_length=5000)
    voice: str | None = None
    language: str | None = None
    clone_mode: Literal["full", "timbre"] = "full"


class ScriptRequest(BaseModel):
    text: str = Field(..., max_length=500_000)


class ClipReleaseRequest(BaseModel):
    keys: list[str] = Field(..., max_length=5000)


CLIP_KEY_RE = re.compile(r"[0-9a-f]{40}")


def build_transcriber(settings: Settings) -> Transcriber | None:
    if settings.quality_stt == "whisper":
        return WhisperTranscriber(settings.stt_model, settings.stt_device, settings.stt_compute_type)
    return None


def _load_engine_in_background(engine: TTSEngine) -> None:
    def run() -> None:
        try:
            engine.load()
        except Exception:  # the error remains in engine.load_error and is exposed through /api/health
            pass

    threading.Thread(target=run, name="tts-loader", daemon=True).start()


def create_app(
    settings: Settings | None = None,
    engine: TTSEngine | None = None,
    transcriber: Transcriber | None | Literal["auto"] = "auto",
) -> FastAPI:
    settings = settings or Settings.from_env()
    engine = engine or build_engine(settings)
    if transcriber == "auto":
        transcriber = build_transcriber(settings)
    for folder in (settings.voices_dir, settings.outputs_dir, settings.presentations_dir, settings.clips_dir):
        folder.mkdir(parents=True, exist_ok=True)
    voices = VoiceStore(settings.voices_dir)
    service = SpeechService(settings, engine, voices)
    presentations = PresentationStore(settings.presentations_dir)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if not engine.loaded:
            _load_engine_in_background(engine)
        yield

    app = FastAPI(title="frvoiceassist", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.engine = engine
    app.state.voices = voices
    app.state.service = service

    @app.get("/api/health")
    def health() -> dict:
        status = "ready" if engine.loaded else ("error" if engine.load_error else "loading")
        return {
            "status": status,
            "engine": engine.name,
            "model": engine.model_id,
            "error": engine.load_error,
            "default_voice": settings.default_voice,
            "default_language": settings.default_language,
            "max_text_chars": settings.max_text_chars,
            "version": __version__,
        }

    @app.get("/api/languages")
    def languages() -> list[str]:
        return SUPPORTED_LANGUAGES

    @app.get("/api/reference-script", response_class=PlainTextResponse)
    def reference_script(lang: Literal["en", "es"] = Query("en")) -> str:
        return (RESOURCES_DIR / f"reference_script_{lang}.txt").read_text(encoding="utf-8").strip()

    def run_quality_check(profile: VoiceProfile) -> dict:
        report = check_reference(profile.audio_path, profile.transcript, transcriber).to_dict()
        profile.save_quality(report)
        return report

    @app.get("/api/voices")
    def list_voices() -> list[dict]:
        return [v.to_dict() for v in voices.list()]

    @app.post("/api/voices", status_code=201)
    async def create_voice(
        name: str = Form(...),
        transcript: str = Form(...),
        overwrite: bool = Form(False),
        audio: UploadFile = File(...),
    ) -> dict:
        data = await audio.read()
        try:
            profile = await run_in_threadpool(
                voices.create, name, data, audio.filename or "upload.bin", transcript, overwrite
            )
        except VoiceError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        await run_in_threadpool(run_quality_check, profile)
        return profile.to_dict()

    @app.post("/api/voices/{name}/check")
    async def check_voice(name: str) -> dict:
        try:
            profile = voices.get(name)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"No existe la voz '{name}'") from exc
        return await run_in_threadpool(run_quality_check, profile)

    @app.get("/api/voices/{name}/audio")
    def voice_audio(name: str) -> FileResponse:
        try:
            profile = voices.get(name)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"No existe la voz '{name}'") from exc
        return FileResponse(profile.audio_path, media_type="audio/wav")

    @app.delete("/api/voices/{name}", status_code=204)
    def delete_voice(name: str) -> Response:
        try:
            voices.delete(name)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"No existe la voz '{name}'") from exc
        return Response(status_code=204)

    async def run_speech(func, *args, voice: str | None):
        """Run synthesis in a thread and translate domain errors into HTTP errors."""
        try:
            return await run_in_threadpool(func, *args)
        except KeyError as exc:
            name = voice or settings.default_voice
            raise HTTPException(
                status_code=404, detail=f"No existe la voz '{name}'. Créala en la pestaña 'Mi voz'."
            ) from exc
        except EngineNotReady as exc:
            raise HTTPException(status_code=503, detail=f"Modelo no disponible: {exc}") from exc
        except TextTooLong as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    # ---------- Per-sentence clips (presentation mode) ----------

    @app.post("/api/clips")
    async def create_clip(req: ClipRequest) -> dict:
        """Return one sentence of audio, generating it only when it is not cached."""
        info = await run_speech(
            service.clip, req.text, req.voice, req.language, req.clone_mode == "timbre", voice=req.voice
        )
        return info.to_dict()

    @app.post("/api/clips/lookup")
    async def lookup_clips(req: ClipLookupRequest) -> list[dict | None]:
        """Return each text's clip when already generated, otherwise null. Generate nothing."""

        def lookup() -> list[dict | None]:
            result = []
            for text in req.texts:
                if not text.strip():
                    result.append(None)
                    continue
                info = service.clip_info(service.clip_key(text, req.voice, req.language, req.clone_mode == "timbre"))
                result.append(info.to_dict() if info else None)
            return result

        return await run_speech(lookup, voice=req.voice)

    # ---------- Presentations ----------

    @app.get("/api/presentations")
    def list_presentations() -> list[dict]:
        return presentations.list()

    @app.post("/api/presentations", status_code=201)
    def create_presentation(data: PresentationData) -> Presentation:
        return presentations.create(data)

    @app.get("/api/presentations/{presentation_id}")
    def get_presentation(presentation_id: str) -> Presentation:
        return get_or_404(presentation_id)

    @app.put("/api/presentations/{presentation_id}")
    def update_presentation(presentation_id: str, data: PresentationData) -> Presentation:
        try:
            return presentations.update(presentation_id, data)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Presentación no encontrada") from exc

    def get_or_404(presentation_id: str) -> Presentation:
        try:
            return presentations.get(presentation_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Presentación no encontrada") from exc

    @app.delete("/api/presentations/{presentation_id}", status_code=204)
    def delete_presentation(presentation_id: str) -> Response:
        p = get_or_404(presentation_id)
        keys = [k for _, _, k in pio.clip_keys(service, p)]
        presentations.delete(presentation_id)
        pio.delete_unreferenced(service, presentations, keys)  # delete its audio when nothing else uses it
        return Response(status_code=204)

    @app.delete("/api/presentations/{presentation_id}/items/{item_id}")
    def delete_item(presentation_id: str, item_id: str) -> dict:
        """Delete a block and its sentence audio when no other block or presentation uses it."""
        p = get_or_404(presentation_id)
        removed = [it for it in p.items if it.id == item_id]
        if not removed:
            raise HTTPException(status_code=404, detail="Bloque no encontrado")
        keys = [k for _, _, k in pio.clip_keys(service, p, removed)]
        data = PresentationData(**{**p.model_dump(), "items": [it for it in p.items if it.id != item_id]})
        updated = presentations.update(presentation_id, data)
        deleted = pio.delete_unreferenced(service, presentations, keys)
        return {"presentation": updated.model_dump(), "deleted_clips": deleted}

    @app.post("/api/clips/release")
    def release_clips(req: ClipReleaseRequest) -> dict:
        """Delete clips no longer used by any presentation, for example after editing a block."""
        keys = [k for k in req.keys if CLIP_KEY_RE.fullmatch(k)]
        return {"deleted": pio.delete_unreferenced(service, presentations, keys)}

    @app.post("/api/clips/cleanup")
    def cleanup_clips() -> dict:
        """Delete all cached audio not used by any presentation."""
        return pio.cleanup_all(service, presentations)

    # ---------- Export / import ----------

    def attachment(filename: str) -> dict:
        ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename)
        return {"Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"}

    @app.get("/api/presentations/{presentation_id}/export.md")
    def export_markdown(presentation_id: str) -> Response:
        p = get_or_404(presentation_id)
        return Response(pio.to_markdown(p), media_type="text/markdown; charset=utf-8",
                        headers=attachment(f"{p.title} - guion.md"))

    @app.get("/api/presentations/{presentation_id}/export.zip")
    async def export_zip(presentation_id: str) -> Response:
        p = get_or_404(presentation_id)
        data, manifest = await run_in_threadpool(pio.build_zip, service, p)
        headers = attachment(f"{p.title}.zip")
        headers["X-Missing-Clips"] = str(len(manifest["missing"]))
        headers["Access-Control-Expose-Headers"] = "X-Missing-Clips"
        return Response(data, media_type="application/zip", headers=headers)

    @app.post("/api/presentations/import", status_code=201)
    async def import_presentation(file: UploadFile = File(...)) -> dict:
        """Import a script (.md/.txt) or complete presentation (.zip) as a new presentation."""
        raw = await file.read()
        name = file.filename or "importado"
        try:
            if name.lower().endswith(".zip") or raw[:2] == b"PK":
                data, clips = await run_in_threadpool(pio.import_zip, raw, service)
            else:
                data, clips = pio.data_from_script(raw.decode("utf-8-sig"), Path(name).stem), 0
        except (pio.ImportError_, UnicodeDecodeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        created = presentations.create(data)
        return {"presentation": created.model_dump(), "imported_clips": clips}

    @app.post("/api/script/parse")
    def parse_script(req: ScriptRequest) -> dict:
        """Convert a pasted script (`# title` plus text) into blocks."""
        settings_, items = pio.parse_script(req.text)
        return {"settings": settings_, "items": [it.model_dump() for it in items]}

    # ---------- Full text ----------

    @app.post("/api/tts")
    async def tts(req: TTSRequest) -> Response:
        result = await run_speech(
            service.synthesize, req.text, req.voice, req.language, req.clone_mode == "timbre", voice=req.voice
        )
        headers = {
            "X-Audio-Duration": f"{result.duration_s:.2f}",
            "X-Generation-Seconds": f"{result.generation_s:.2f}",
            "X-Chunks": str(result.chunks),
            "Access-Control-Expose-Headers": "X-Audio-Duration, X-Generation-Seconds, X-Chunks, X-Output-File",
        }
        if result.output_file:
            headers["X-Output-File"] = result.output_file
        return Response(content=result.wav_bytes, media_type="audio/wav", headers=headers)

    app.mount("/outputs", StaticFiles(directory=settings.outputs_dir), name="outputs")
    app.mount("/clips", StaticFiles(directory=settings.clips_dir), name="clips")
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    return app


def main_app() -> FastAPI:
    """Uvicorn factory (--factory); importing the module creates no directories and loads nothing."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()
