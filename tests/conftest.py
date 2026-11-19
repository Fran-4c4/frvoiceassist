from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.tts.fake import FakeEngine


def make_wav_bytes(seconds: float, sample_rate: int = 16_000, channels: int = 1) -> bytes:
    t = np.arange(int(sample_rate * seconds), dtype=np.float32) / sample_rate
    tone = 0.2 * np.sin(2 * np.pi * 220 * t)
    data = np.stack([tone] * channels, axis=1) if channels > 1 else tone
    buffer = io.BytesIO()
    sf.write(buffer, data, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


class FakeTranscriber:
    """Simulate Whisper by returning fixed text."""

    def __init__(self, text: str = "Hello, this is my voice.", language: str = "en") -> None:
        self.text = text
        self.language = language
        self.calls = 0

    def transcribe(self, audio_16k):
        self.calls += 1
        return self.text, self.language


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        engine="fake", workspace_dir=tmp_path / "workspace", chunk_chars=60, max_text_chars=500, quality_stt="none"
    )


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def transcriber() -> FakeTranscriber:
    return FakeTranscriber()


@pytest.fixture
def client(settings: Settings, engine: FakeEngine, transcriber: FakeTranscriber):
    with TestClient(create_app(settings, engine, transcriber)) as test_client:
        yield test_client


@pytest.fixture
def voice_me(client: TestClient) -> dict:
    res = client.post(
        "/api/voices",
        data={"name": "me", "transcript": "Hello, this is my voice."},
        files={"audio": ("me.wav", make_wav_bytes(5.0), "audio/wav")},
    )
    assert res.status_code == 201, res.text
    return res.json()
