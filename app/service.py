"""Orchestrate synthesis: validate, split text, call the engine, concatenate, and save the result."""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import soundfile as sf

from app.audio import concat_with_pauses, encode_wav, peak_normalize
from app.config import Settings
from app.text import chunk_text
from app.tts.base import TTSEngine
from app.voices import VoiceProfile, VoiceStore

log = logging.getLogger(__name__)

SUPPORTED_LANGUAGES = [
    "English", "Spanish", "Chinese", "Japanese", "Korean",
    "German", "French", "Russian", "Portuguese", "Italian",
]


class TextTooLong(ValueError):
    pass


@dataclass(frozen=True)
class ClipInfo:
    key: str
    duration_s: float
    cached: bool

    def to_dict(self) -> dict:
        return {"key": self.key, "url": f"/clips/{self.key}.wav", "duration_s": self.duration_s, "cached": self.cached}


@dataclass(frozen=True)
class SynthesisResult:
    wav_bytes: bytes
    sample_rate: int
    duration_s: float
    generation_s: float
    chunks: int
    output_file: str | None


def _slug(text: str, length: int = 32) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:length].rstrip("-") or "speech"


class SpeechService:
    def __init__(self, settings: Settings, engine: TTSEngine, voices: VoiceStore) -> None:
        self.settings = settings
        self.engine = engine
        self.voices = voices
        self._clip_locks: dict[str, threading.Lock] = {}
        self._clip_locks_guard = threading.Lock()

    def _validate(self, text: str, voice_name: str | None, language: str | None) -> tuple[str, VoiceProfile, str]:
        text = (text or "").strip()
        if not text:
            raise ValueError("El texto está vacío.")
        if len(text) > self.settings.max_text_chars:
            raise TextTooLong(f"El texto supera el máximo de {self.settings.max_text_chars} caracteres.")
        language = language or self.settings.default_language
        if language not in SUPPORTED_LANGUAGES:
            raise ValueError(f"Idioma no soportado: {language}. Opciones: {', '.join(SUPPORTED_LANGUAGES)}")
        voice = self.voices.get(voice_name or self.settings.default_voice)  # KeyError -> 404
        return text, voice, language

    # ---------- Clips: per-sentence audio cached on disk (presentation mode) ----------

    def clip_key(self, text: str, voice_name: str | None, language: str | None, timbre_only: bool) -> str:
        text, voice, language = self._validate(text, voice_name, language)
        raw = "|".join([self.engine.model_id, voice.name, voice.fingerprint, language,
                        "timbre" if timbre_only else "full", " ".join(text.split())])
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def clip_path(self, key: str) -> Path:
        return self.settings.clips_dir / f"{key}.wav"

    def clip_info(self, key: str) -> ClipInfo | None:
        path = self.clip_path(key)
        if not path.is_file():
            return None
        return ClipInfo(key, round(float(sf.info(str(path)).duration), 2), cached=True)

    def clip(self, text: str, voice_name: str | None, language: str | None, timbre_only: bool) -> ClipInfo:
        """Return one sentence clip, generating it only when it is not cached."""
        key = self.clip_key(text, voice_name, language, timbre_only)
        with self._clip_locks_guard:
            lock = self._clip_locks.setdefault(key, threading.Lock())
        with lock:  # prevent duplicate generation when concurrent requests contain the same sentence
            info = self.clip_info(key)
            if info:
                return info
            result = self.synthesize(text, voice_name, language, timbre_only, save_output=False)
            path = self.clip_path(key)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(result.wav_bytes)
            tmp.replace(path)
            return ClipInfo(key, round(result.duration_s, 2), cached=False)

    # ---------- Full text -> one WAV file ----------

    def synthesize(
        self,
        text: str,
        voice_name: str | None = None,
        language: str | None = None,
        timbre_only: bool = False,
        save_output: bool | None = None,
    ) -> SynthesisResult:
        text, voice, language = self._validate(text, voice_name, language)

        chunks = chunk_text(text, self.settings.chunk_chars)
        started = time.perf_counter()
        segments = []
        sample_rate = 0
        for i, chunk in enumerate(chunks, 1):
            chunk_started = time.perf_counter()
            audio, sample_rate = self.engine.synthesize(chunk, language, voice, timbre_only)
            elapsed = time.perf_counter() - chunk_started
            seconds = audio.size / sample_rate if sample_rate else 0.0
            log.info("Fragmento %d/%d: %d caracteres -> %.1f s de audio en %.1f s (RTF %.2f)",
                     i, len(chunks), len(chunk), seconds, elapsed, elapsed / seconds if seconds else 0.0)
            segments.append(audio)
        generation_s = time.perf_counter() - started

        audio = peak_normalize(concat_with_pauses(segments, sample_rate, self.settings.pause_ms))
        wav_bytes = encode_wav(audio, sample_rate)
        duration_s = audio.size / sample_rate if sample_rate else 0.0
        log.info("Audio de %.1f s generado en %.1f s (RTF %.2f)", duration_s, generation_s,
                 generation_s / duration_s if duration_s else 0.0)

        output_file = None
        if self.settings.save_outputs if save_output is None else save_output:
            self.settings.outputs_dir.mkdir(parents=True, exist_ok=True)
            output_file = f"{datetime.now():%Y%m%d-%H%M%S}-{voice.name}-{_slug(text)}.wav"
            (Path(self.settings.outputs_dir) / output_file).write_bytes(wav_bytes)

        return SynthesisResult(wav_bytes, sample_rate, duration_s, generation_s, len(chunks), output_file)
