"""Audio utilities: mono conversion, concatenation, normalization, and WAV encoding."""

from __future__ import annotations

import io
from collections.abc import Sequence

import numpy as np
import soundfile as sf


def to_mono_float32(wav: object) -> np.ndarray:
    audio = np.asarray(wav, dtype=np.float32)
    audio = np.squeeze(audio)
    if audio.ndim == 2:
    # soundfile returns (frames, channels); some models return (channels, frames)
        channel_axis = 0 if audio.shape[0] < audio.shape[1] else 1
        audio = audio.mean(axis=channel_axis)
    if audio.ndim != 1:
        raise ValueError(f"Forma de audio no soportada: {audio.shape}")
    return np.nan_to_num(audio)


def concat_with_pauses(segments: Sequence[np.ndarray], sample_rate: int, pause_ms: int) -> np.ndarray:
    if not segments:
        return np.zeros(0, dtype=np.float32)
    silence = np.zeros(int(sample_rate * max(pause_ms, 0) / 1000), dtype=np.float32)
    parts: list[np.ndarray] = []
    for i, segment in enumerate(segments):
        if i:
            parts.append(silence)
        parts.append(to_mono_float32(segment))
    return np.concatenate(parts)


def peak_normalize(audio: np.ndarray, peak: float = 0.95) -> np.ndarray:
    max_abs = float(np.max(np.abs(audio))) if audio.size else 0.0
    if max_abs < 1e-6:
        return audio
    return (audio * (peak / max_abs)).astype(np.float32)


def encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, np.clip(audio, -1.0, 1.0), sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()
