"""Fake engine that generates a tone whose duration depends on the text, without a GPU or model.

Useful for tests, CI, and UI development without waiting for Qwen3-TTS to load.
"""

from __future__ import annotations

import numpy as np

from app.voices import VoiceProfile

SAMPLE_RATE = 24_000


class FakeEngine:
    name = "fake"
    model_id = "fake-sine"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, bool]] = []

    @property
    def loaded(self) -> bool:
        return True

    @property
    def load_error(self) -> str | None:
        return None

    def load(self) -> None:
        return None

    def synthesize(
        self, text: str, language: str, voice: VoiceProfile, timbre_only: bool = False
    ) -> tuple[np.ndarray, int]:
        self.calls.append((text, language, voice.name, timbre_only))
        seconds = min(0.5 + 0.04 * len(text), 20.0)
        t = np.arange(int(SAMPLE_RATE * seconds), dtype=np.float32) / SAMPLE_RATE
        freq = 180.0 + (sum(map(ord, voice.name)) % 120)
        return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32), SAMPLE_RATE
