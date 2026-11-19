"""Qwen3-TTS engine (*-Base models, voice cloning from reference audio).

Reference: https://github.com/QwenLM/Qwen3-TTS (PyPI package `qwen-tts`).
torch and qwen_tts are imported inside `load()` so the app and tests work without a GPU.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import numpy as np

from app.audio import to_mono_float32
from app.config import Settings
from app.tts.base import EngineNotReady
from app.voices import VoiceProfile

log = logging.getLogger(__name__)


class QwenEngine:
    name = "qwen"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model_id = settings.model_id
        self._model: Any = None
        self._load_error: str | None = None
        self._load_lock = threading.Lock()
        self._gen_lock = threading.Lock()  # allow only one GPU generation at a time
        self._prompts: dict[str, tuple[str, Any]] = {}
        self.attn_implementation: str | None = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def _attn_candidates(self) -> list[str]:
        candidates = [self.settings.attn_implementation]
        if candidates[0] == "flash_attention_2":
            try:
                import flash_attn  # noqa: F401
            except ImportError:
                log.warning("flash-attn no está instalado; se usará sdpa")
                candidates = []
        for fallback in ("sdpa", "eager"):
            if fallback not in candidates:
                candidates.append(fallback)
        return candidates

    def load(self) -> None:
        with self._load_lock:
            if self._model is not None:
                return
            self._load_error = None
            try:
                import torch
                from qwen_tts import Qwen3TTSModel

                if self.settings.device.startswith("cuda") and not torch.cuda.is_available():
                    raise RuntimeError(
                        "CUDA no disponible dentro del contenedor. Revisa el driver NVIDIA y que Docker "
                        "tenga acceso a la GPU (ver README, sección 'Comprobar la GPU')."
                    )
                dtype = getattr(torch, self.settings.dtype)
                last_exc: Exception | None = None
                started = time.perf_counter()
                for attn in self._attn_candidates():
                    try:
                        log.info("Cargando %s (dtype=%s, attn=%s)...", self.model_id, self.settings.dtype, attn)
                        model = Qwen3TTSModel.from_pretrained(
                            self.model_id,
                            device_map=self.settings.device,
                            dtype=dtype,
                            attn_implementation=attn,
                        )
                    except Exception as exc:  # for example, attention unsupported by this version
                        log.warning("Fallo cargando con attn=%s: %s", attn, exc)
                        last_exc = exc
                        continue
                    self._model = model
                    self.attn_implementation = attn
                    log.info("Modelo cargado en %.1f s", time.perf_counter() - started)
                    return
                raise RuntimeError(f"No se pudo cargar el modelo: {last_exc}") from last_exc
            except Exception as exc:
                self._load_error = str(exc)
                log.exception("Error cargando Qwen3-TTS")
                raise

    def _voice_prompt(self, voice: VoiceProfile, timbre_only: bool) -> Any:
        """Compute and cache a cloning prompt once per voice and mode, rather than once per sentence."""
        fingerprint = voice.fingerprint
        key = f"{voice.name}:{'timbre' if timbre_only else 'full'}"
        cached = self._prompts.get(key)
        if cached and cached[0] == fingerprint:
            return cached[1]
        log.info("Preparando prompt de clonado '%s'", key)
        prompt = self._model.create_voice_clone_prompt(
            ref_audio=str(voice.audio_path),
            ref_text=voice.transcript,
            x_vector_only_mode=timbre_only,
        )
        self._prompts[key] = (fingerprint, prompt)
        return prompt

    def synthesize(
        self, text: str, language: str, voice: VoiceProfile, timbre_only: bool = False
    ) -> tuple[np.ndarray, int]:
        if self._model is None:
            raise EngineNotReady(self._load_error or "El modelo todavía se está cargando")
        with self._gen_lock:
            prompt = self._voice_prompt(voice, timbre_only)
            wavs, sample_rate = self._model.generate_voice_clone(
                text=text,
                language=language,
                voice_clone_prompt=prompt,
                max_new_tokens=self.settings.max_new_tokens,
            )
        return to_mono_float32(wavs[0]), int(sample_rate)
