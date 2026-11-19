"""Manage voice profiles (reference audio plus transcript).

On-disk layout (inside WORKSPACE_DIR/voices):

    voices/
      me/
        reference.wav   # 24 kHz mono, 3-60 s (ideal 10-20 s)
        reference.txt   # EXACT transcript of reference.wav
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

from app.audio import to_mono_float32

AUDIO_FILE = "reference.wav"
TRANSCRIPT_FILE = "reference.txt"
QUALITY_FILE = "quality.json"
TARGET_SAMPLE_RATE = 24_000
MIN_SECONDS = 3.0
MAX_SECONDS = 60.0
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")


class VoiceError(ValueError):
    """Validation error while creating a voice profile."""


_DIGESTS: dict[tuple[str, int, int], str] = {}


def _file_digest(path: Path) -> str:
    """Return the file's SHA-1, cached while its timestamp and size remain unchanged."""
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size)
    if key not in _DIGESTS:
        _DIGESTS[key] = hashlib.sha1(path.read_bytes()).hexdigest()[:16]
    return _DIGESTS[key]


@dataclass(frozen=True)
class VoiceProfile:
    name: str
    audio_path: Path
    transcript: str
    duration_s: float

    @property
    def fingerprint(self) -> str:
        """Return a content fingerprint (audio plus transcript).

        It changes when the voice is replaced, but not when copied to another computer, keeping the audio cache
        and exported presentations valid.
        """
        text_digest = hashlib.sha1(self.transcript.encode("utf-8")).hexdigest()[:12]
        return f"{_file_digest(self.audio_path)}:{text_digest}"

    @property
    def quality_path(self) -> Path:
        return self.audio_path.parent / QUALITY_FILE

    def load_quality(self) -> dict | None:
        """Return the latest saved quality report when it still matches the current audio and transcript."""
        try:
            data = json.loads(self.quality_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data.get("report") if data.get("fingerprint") == self.fingerprint else None

    def save_quality(self, report: dict) -> None:
        payload = {"fingerprint": self.fingerprint, "report": report}
        self.quality_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "transcript": self.transcript,
            "duration_s": round(self.duration_s, 2),
            "quality": self.load_quality(),
        }


def _convert_with_ffmpeg(src: Path, dst: Path) -> None:
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src), "-ac", "1", "-ar", str(TARGET_SAMPLE_RATE), "-c:a", "pcm_s16le", str(dst),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise VoiceError(f"No se pudo convertir el audio con ffmpeg: {result.stderr.strip()[:300]}")


def _convert_with_soundfile(src: Path, dst: Path) -> None:
    try:
        data, sample_rate = sf.read(str(src), dtype="float32", always_2d=False)
    except Exception as exc:  # unsupported format (webm/mp3 without ffmpeg, corrupt file, and so on)
        raise VoiceError(
            "Formato de audio no soportado. Sube un WAV/FLAC o instala ffmpeg (incluido en la imagen Docker)."
        ) from exc
    sf.write(str(dst), to_mono_float32(data), sample_rate, subtype="PCM_16")


def convert_reference_audio(src: Path, dst: Path) -> None:
    if shutil.which("ffmpeg"):
        _convert_with_ffmpeg(src, dst)
    else:
        _convert_with_soundfile(src, dst)


class VoiceStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _load(self, folder: Path) -> VoiceProfile | None:
        audio = folder / AUDIO_FILE
        transcript_file = folder / TRANSCRIPT_FILE
        if not (audio.is_file() and transcript_file.is_file()):
            return None
        transcript = transcript_file.read_text(encoding="utf-8").strip()
        if not transcript:
            return None
        try:
            duration = float(sf.info(str(audio)).duration)
        except Exception:
            return None
        return VoiceProfile(folder.name, audio, transcript, duration)

    def list(self) -> list[VoiceProfile]:
        if not self.root.is_dir():
            return []
        profiles = (self._load(p) for p in sorted(self.root.iterdir()) if p.is_dir() and NAME_RE.match(p.name))
        return [p for p in profiles if p is not None]

    def get(self, name: str) -> VoiceProfile:
        if not NAME_RE.match(name or ""):
            raise KeyError(name)
        profile = self._load(self.root / name)
        if profile is None:
            raise KeyError(name)
        return profile

    def create(
        self, name: str, audio_bytes: bytes, filename: str, transcript: str, overwrite: bool = False
    ) -> VoiceProfile:
        name = (name or "").strip().lower()
        transcript = " ".join((transcript or "").split())
        if not NAME_RE.match(name):
            raise VoiceError("Nombre inválido: usa minúsculas, números, '-' o '_' (máx. 40 caracteres).")
        if not transcript:
            raise VoiceError("La transcripción es obligatoria y debe coincidir con lo que se dice en el audio.")
        if not audio_bytes:
            raise VoiceError("El audio está vacío.")
        target = self.root / name
        if target.exists() and not overwrite:
            raise VoiceError(f"Ya existe la voz '{name}'. Marca 'sobrescribir' para reemplazarla.")

        self.root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{name}-", dir=self.root))
        try:
            suffix = Path(filename or "upload.bin").suffix.lower() or ".bin"
            raw = staging / f"upload{suffix}"
            raw.write_bytes(audio_bytes)
            convert_reference_audio(raw, staging / AUDIO_FILE)
            raw.unlink()
            duration = float(sf.info(str(staging / AUDIO_FILE)).duration)
            if duration < MIN_SECONDS:
                raise VoiceError(f"Audio demasiado corto ({duration:.1f} s). Mínimo {MIN_SECONDS:.0f} s; ideal 10-20.")
            if duration > MAX_SECONDS:
                raise VoiceError(f"Audio demasiado largo ({duration:.1f} s). Máximo {MAX_SECONDS:.0f} s; ideal 10-20.")
            (staging / TRANSCRIPT_FILE).write_text(transcript + "\n", encoding="utf-8")
            if target.exists():
                shutil.rmtree(target)
            staging.rename(target)
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
        return self.get(name)

    def delete(self, name: str) -> None:
        profile = self.get(name)  # raise KeyError when missing
        shutil.rmtree(profile.audio_path.parent)
