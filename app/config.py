"""Application settings loaded from environment variables (see .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_TTS_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
QWEN_BASE_MODELS = (
    DEFAULT_TTS_MODEL,
    "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
)


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else default


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value and value.strip() else default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "si", "sí"}


@dataclass(frozen=True)
class Settings:
    # TTS engine: "qwen" (real, GPU-backed) or "fake" (synthetic tone for tests and UI development)
    engine: str = "qwen"
    # Hugging Face model ID passed to qwen-tts. QWEN_BASE_MODELS lists the supported Base variants; compatible
    # custom IDs are passed through unchanged. Changing the model invalidates the sentence-audio cache key.
    model_id: str = DEFAULT_TTS_MODEL
    device: str = "cuda:0"
    dtype: str = "bfloat16"
    # Use "flash_attention_2" only when the image includes flash-attn; failures fall back to sdpa and eager
    attn_implementation: str = "sdpa"
    default_language: str = "English"
    default_voice: str = "me"
    # Personal data (voices, presentations, and audio). Docker mounts ~/frvoiceassist at /workspace.
    workspace_dir: Path = field(default_factory=lambda: Path.home() / "frvoiceassist")
    max_text_chars: int = 5000
    chunk_chars: int = 300
    max_new_tokens: int = 2048
    pause_ms: int = 250
    save_outputs: bool = True
    # Reference-recording check with Whisper: "whisper" | "none"
    quality_stt: str = "whisper"
    stt_model: str = "small"
    stt_device: str = "cpu"
    stt_compute_type: str = "int8"

    @property
    def voices_dir(self) -> Path:
        return self.workspace_dir / "voices"

    @property
    def outputs_dir(self) -> Path:
        return self.workspace_dir / "outputs"

    @property
    def presentations_dir(self) -> Path:
        return self.workspace_dir / "presentations"

    @property
    def clips_dir(self) -> Path:
        """Per-sentence audio cache; safe to delete because it can be regenerated."""
        return self.workspace_dir / "cache" / "clips"

    @classmethod
    def from_env(cls) -> Settings:
        d = cls()
        return cls(
            engine=_env_str("TTS_ENGINE", d.engine).lower(),
            model_id=_env_str("TTS_MODEL", d.model_id),
            device=_env_str("TTS_DEVICE", d.device),
            dtype=_env_str("TTS_DTYPE", d.dtype),
            attn_implementation=_env_str("TTS_ATTN", d.attn_implementation),
            default_language=_env_str("TTS_LANGUAGE", d.default_language),
            default_voice=_env_str("TTS_DEFAULT_VOICE", d.default_voice),
            workspace_dir=Path(_env_str("WORKSPACE_DIR", str(d.workspace_dir))).expanduser(),
            max_text_chars=_env_int("TTS_MAX_TEXT_CHARS", d.max_text_chars),
            chunk_chars=_env_int("TTS_CHUNK_CHARS", d.chunk_chars),
            max_new_tokens=_env_int("TTS_MAX_NEW_TOKENS", d.max_new_tokens),
            pause_ms=_env_int("TTS_PAUSE_MS", d.pause_ms),
            save_outputs=_env_bool("TTS_SAVE_OUTPUTS", d.save_outputs),
            quality_stt=_env_str("QUALITY_STT", d.quality_stt).lower(),
            stt_model=_env_str("STT_MODEL", d.stt_model),
            stt_device=_env_str("STT_DEVICE", d.stt_device),
            stt_compute_type=_env_str("STT_COMPUTE_TYPE", d.stt_compute_type),
        )
