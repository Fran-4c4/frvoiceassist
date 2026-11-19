"""Quality checks for a reference recording.

Qwen3-TTS does not return metrics when preparing a voice, so they are calculated here:
- Signal metrics: duration, level, background noise, SNR, clipping, and silence.
- Whisper transcription (faster-whisper) compared with the saved transcript. If Whisper hears something other
  than reference.txt, Qwen receives a misaligned prompt and voice-cloning quality degrades.
"""

from __future__ import annotations

import difflib
import logging
import re
import threading
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np
import soundfile as sf

from app.audio import to_mono_float32

log = logging.getLogger(__name__)

FRAME_S = 0.05


@dataclass
class QualityReport:
    verdict: str  # ok | warn | bad
    metrics: dict
    warnings: list[str] = field(default_factory=list)
    transcription: str | None = None
    detected_language: str | None = None
    word_match: float | None = None

    def to_dict(self) -> dict:
        return {
            "verdict": self.verdict,
            "metrics": self.metrics,
            "warnings": self.warnings,
            "transcription": self.transcription,
            "detected_language": self.detected_language,
            "word_match": self.word_match,
        }


class Transcriber(Protocol):
    def transcribe(self, audio_16k: np.ndarray) -> tuple[str, str | None]:
        """Return (text, detected language) for 16 kHz mono float32 audio."""


def resample(audio: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return audio.astype(np.float32)
    try:
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(sr, target)
        return resample_poly(audio, target // g, sr // g).astype(np.float32)
    except ImportError:  # without scipy, linear interpolation is sufficient for STT
        n = int(round(len(audio) * target / sr))
        return np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)


def signal_metrics(audio: np.ndarray, sr: int) -> dict:
    audio = to_mono_float32(audio)
    frame = max(int(sr * FRAME_S), 1)
    n = len(audio) // frame
    if n == 0:
        return {"duration_s": round(len(audio) / sr, 2)}
    frames = audio[: n * frame].reshape(n, frame)
    db = 20 * np.log10(np.sqrt(np.mean(frames**2, axis=1)) + 1e-9)
    # A low percentile works when roughly 3% of the recording contains pauses, providing a good noise estimate
    noise_db = float(np.percentile(db, 3))
    speech_db = float(np.percentile(db, 90))
    voiced = np.flatnonzero(db > noise_db + 15)
    lead = float(voiced[0] * FRAME_S) if voiced.size else 0.0
    trail = float((n - 1 - voiced[-1]) * FRAME_S) if voiced.size else 0.0
    peak = float(np.max(np.abs(audio)))
    return {
        "duration_s": round(len(audio) / sr, 2),
        "peak_dbfs": round(20 * np.log10(peak + 1e-9), 1),
        "speech_dbfs": round(speech_db, 1),
        "noise_dbfs": round(noise_db, 1),
        "snr_db": round(speech_db - noise_db, 1),
        "clipping_pct": round(float(np.mean(np.abs(audio) > 0.99)) * 100, 3),
        "leading_silence_s": round(lead, 2),
        "trailing_silence_s": round(trail, 2),
    }


def _words(text: str) -> list[str]:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.findall(r"[a-z0-9']+", text)


def word_match(expected: str, heard: str) -> float:
    """Return the matching-word ratio (0-1) between the saved transcript and Whisper's result."""
    a, b = _words(expected), _words(heard)
    if not a and not b:
        return 1.0
    return round(difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(), 3)


def evaluate(metrics: dict, transcript: str, transcription: str | None) -> tuple[str, list[str], float | None]:
    warnings: list[str] = []
    bad = False
    duration = metrics.get("duration_s", 0)
    if duration < 8:
        warnings.append(f"Audio corto ({duration} s): con 10-20 s el clonado suele ser más fiel.")
    elif duration > 30:
        warnings.append(f"Audio largo ({duration} s): más de 30 s ralentiza cada generación sin mejorar mucho.")
    if metrics.get("clipping_pct", 0) > 0.1:
        bad = True
        warnings.append("Hay saturación (clipping): baja la ganancia del micrófono y vuelve a grabar.")
    if metrics.get("snr_db", 99) < 25:
        bad = True
        warnings.append(f"Mucho ruido de fondo (SNR {metrics.get('snr_db')} dB): busca un sitio más silencioso.")
    elif metrics.get("snr_db", 99) < 35:
        warnings.append(f"Algo de ruido de fondo (SNR {metrics.get('snr_db')} dB).")
    if metrics.get("speech_dbfs", 0) < -35:
        warnings.append("Volumen bajo: acércate al micrófono o sube la ganancia.")
    if metrics.get("leading_silence_s", 0) > 1.5 or metrics.get("trailing_silence_s", 0) > 1.5:
        warnings.append("Silencio largo al principio o al final: recórtalo o vuelve a grabar.")
    match = None
    if transcription is not None:
        match = word_match(transcript, transcription)
        if match < 0.8:
            bad = True
            warnings.append(
                f"La transcripción solo coincide un {match:.0%} con lo que se oye. Corrige el texto para que "
                "diga exactamente lo que dices (o vuelve a grabar)."
            )
        elif match < 0.95:
            warnings.append(f"La transcripción coincide un {match:.0%}: revisa las palabras que difieren.")
    verdict = "bad" if bad else ("warn" if warnings else "ok")
    return verdict, warnings, match


def check_reference(path: Path, transcript: str, transcriber: Transcriber | None) -> QualityReport:
    audio, sr = sf.read(str(path), dtype="float32", always_2d=False)
    audio = to_mono_float32(audio)
    metrics = signal_metrics(audio, sr)
    transcription = language = None
    if transcriber is not None:
        try:
            transcription, language = transcriber.transcribe(resample(audio, sr, 16_000))
        except Exception as exc:  # the check must never prevent saving the voice
            log.warning("No se pudo transcribir la referencia: %s", exc)
    verdict, warnings, match = evaluate(metrics, transcript, transcription)
    return QualityReport(verdict, metrics, warnings, transcription, language, match)


class WhisperTranscriber:
    """Load faster-whisper on demand (CPU int8 by default to avoid competing with Qwen for VRAM)."""

    def __init__(self, model_name: str = "small", device: str = "cpu", compute_type: str = "int8") -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self._model = None
        self._lock = threading.Lock()

    def transcribe(self, audio_16k: np.ndarray) -> tuple[str, str | None]:
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                log.info("Cargando Whisper %s (%s/%s)", self.model_name, self.device, self.compute_type)
                self._model = WhisperModel(self.model_name, device=self.device, compute_type=self.compute_type)
            segments, info = self._model.transcribe(audio_16k, beam_size=5, condition_on_previous_text=False)
            text = " ".join(s.text.strip() for s in segments).strip()
        return text, getattr(info, "language", None)
