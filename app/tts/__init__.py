"""Available TTS engines."""

from __future__ import annotations

from app.config import Settings
from app.tts.base import EngineNotReady, TTSEngine

__all__ = ["EngineNotReady", "TTSEngine", "build_engine"]


def build_engine(settings: Settings) -> TTSEngine:
    if settings.engine == "fake":
        from app.tts.fake import FakeEngine

        return FakeEngine()
    if settings.engine == "qwen":
        from app.tts.qwen import QwenEngine

        return QwenEngine(settings)
    raise ValueError(f"TTS_ENGINE desconocido: {settings.engine!r} (usa 'qwen' o 'fake')")
