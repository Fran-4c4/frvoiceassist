"""Common TTS engine interface, allowing model replacement without changing the API."""

from __future__ import annotations

from typing import Protocol

import numpy as np

from app.voices import VoiceProfile


class EngineNotReady(RuntimeError):
    """The model is still loading or failed to load."""


class TTSEngine(Protocol):
    name: str
    model_id: str

    @property
    def loaded(self) -> bool: ...

    @property
    def load_error(self) -> str | None: ...

    def load(self) -> None:
        """Load the model (blocking). Must be idempotent."""

    def synthesize(
        self, text: str, language: str, voice: VoiceProfile, timbre_only: bool = False
    ) -> tuple[np.ndarray, int]:
        """Return (mono float32 audio in [-1, 1], sample_rate) for a text chunk.

        timbre_only=True clones only the timbre (speaker embedding), without the reference accent or rhythm.
        """
