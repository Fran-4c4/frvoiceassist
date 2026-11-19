"""Presentation export/import and orphaned-audio cleanup.

- Script (.md): editable text. Each block is a `# title` line followed by its text. The first line is an HTML
  comment containing settings (title, voice, cloning mode, language) so the file can be reimported unchanged.
- Complete presentation (.zip): presentation.json + guion.md + clips/<key>.wav (per-sentence audio) +
  presentacion_completa.wav (continuous backup audio) + manifest.json.
"""

from __future__ import annotations

import io
import json
import logging
import re
import zipfile
from collections.abc import Iterable
from datetime import datetime

import numpy as np
import soundfile as sf

from app.audio import encode_wav, to_mono_float32
from app.presentations import Presentation, PresentationData, PresentationItem, PresentationStore
from app.sentences import spoken_sentences
from app.service import SpeechService

log = logging.getLogger(__name__)

HEADER_RE = re.compile(r"^\s*<!--\s*frvoiceassist\s+(\{.*\})\s*-->\s*$")
TITLE_RE = re.compile(r"^\s*#+[ \t]*(.*?)\s*$")
CLIP_NAME_RE = re.compile(r"^clips/([0-9a-f]{40})\.wav$")
MAX_IMPORT_BYTES = 1024 * 1024 * 1024  # 1 GB descomprimido
SENTENCE_GAP_S = 0.25
BLOCK_GAP_S = 1.0


class ImportError_(ValueError):
    """Invalid import file."""


# ----------------------------------------------------------------------------- Markdown script


def to_markdown(p: PresentationData) -> str:
    header = {"title": p.title, "voice": p.voice, "clone_mode": p.clone_mode, "language": p.language}
    lines = [f"<!-- frvoiceassist {json.dumps(header, ensure_ascii=False)} -->", ""]
    for item in p.items:
        lines.append(f"# {item.title}".rstrip())
        if item.text.strip():
            lines.append(item.text.strip())
        lines.append("")
    return "\n".join(lines)


def parse_script(raw: str) -> tuple[dict, list[PresentationItem]]:
    """Return (header settings, blocks).

    Each `# title` line starts a block; without headings, each paragraph separated by a blank line is a block.
    """
    settings: dict = {}
    lines = []
    for line in raw.replace("\r\n", "\n").split("\n"):
        m = HEADER_RE.match(line)
        if m:
            try:
                settings = json.loads(m.group(1))
            except ValueError:
                pass
            continue
        lines.append(line)

    blocks: list[tuple[str, list[str]]] = []
    if any(TITLE_RE.match(line) for line in lines):
        for line in lines:
            m = TITLE_RE.match(line)
            if m:
                blocks.append((m.group(1), []))
            else:
                if not blocks:
                    blocks.append(("", []))
                blocks[-1][1].append(line)
    else:
        for para in re.split(r"\n\s*\n", "\n".join(lines)):
            blocks.append(("", [para]))

    items = []
    for title, text_lines in blocks:
        text = "\n".join(text_lines).strip()
        if title or text:
            items.append(PresentationItem(title=title[:300], text=text))
    return settings, items


def data_from_script(raw: str, fallback_title: str) -> PresentationData:
    settings, items = parse_script(raw)
    if not items:
        raise ImportError_("El guion no contiene ningún bloque.")
    clone_mode = settings.get("clone_mode") if settings.get("clone_mode") in ("full", "timbre") else "full"
    return PresentationData(
        title=(str(settings.get("title") or fallback_title or "Presentación importada"))[:200],
        voice=settings.get("voice") or None,
        language=settings.get("language") or None,
        clone_mode=clone_mode,
        items=items,
    )


# ----------------------------------------------------------------------------- Presentation clips


def clip_keys(service: SpeechService, p: PresentationData, items: Iterable[PresentationItem] | None = None) -> list:
    """Return ``[(item, sentence, key)]`` for spoken sentences; keys are absent when the voice is missing."""
    result = []
    timbre = p.clone_mode == "timbre"
    for item in p.items if items is None else items:
        for text in spoken_sentences(item.text):
            try:
                result.append((item, text, service.clip_key(text, p.voice, p.language, timbre)))
            except (KeyError, ValueError):
                return []
    return result


def referenced_keys(service: SpeechService, store: PresentationStore) -> set[str]:
    keys: set[str] = set()
    for summary in store.list():
        try:
            p = store.get(summary["id"])
        except (KeyError, ValueError):
            continue
        keys.update(k for _, _, k in clip_keys(service, p))
    return keys


def delete_unreferenced(service: SpeechService, store: PresentationStore, candidates: Iterable[str]) -> int:
    """Delete candidate cache clips no longer used by any presentation."""
    in_use = referenced_keys(service, store)
    deleted = 0
    for key in set(candidates) - in_use:
        path = service.clip_path(key)
        if path.is_file():
            path.unlink()
            deleted += 1
    if deleted:
        log.info("Borrados %d clips de audio que ya no se usan", deleted)
    return deleted


def cleanup_all(service: SpeechService, store: PresentationStore) -> dict:
    in_use = referenced_keys(service, store)
    deleted, freed = 0, 0
    for path in service.settings.clips_dir.glob("*.wav"):
        if path.stem not in in_use:
            freed += path.stat().st_size
            path.unlink()
            deleted += 1
    return {"deleted": deleted, "freed_mb": round(freed / 1024 / 1024, 1)}


# ----------------------------------------------------------------------------- ZIP archive


def build_zip(service: SpeechService, p: Presentation) -> tuple[bytes, dict]:
    entries = clip_keys(service, p)
    buffer = io.BytesIO()
    manifest = {
        "format": "frvoiceassist-presentation",
        "version": 1,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "model": service.engine.model_id,
        "clips": [],
        "missing": [],
        "full_audio": None,
    }
    blocks_audio: list[list[np.ndarray]] = []
    sample_rate = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("presentation.json", json.dumps(p.model_dump(), ensure_ascii=False, indent=2))
        zf.writestr("guion.md", to_markdown(p))
        written: set[str] = set()
        current_item = None
        for item, text, key in entries:
            if item is not current_item:
                blocks_audio.append([])
                current_item = item
            path = service.clip_path(key)
            if not path.is_file():
                manifest["missing"].append({"item_id": item.id, "text": text})
                continue
            if key not in written:
                zf.write(path, f"clips/{key}.wav")
                written.add(key)
            manifest["clips"].append({"item_id": item.id, "text": text, "file": f"clips/{key}.wav"})
            data, sr = sf.read(str(path), dtype="float32")
            sample_rate = sample_rate or sr
            if sr == sample_rate:
                blocks_audio[-1].append(to_mono_float32(data))
        if entries and not manifest["missing"] and sample_rate:
            sentence_gap = np.zeros(int(sample_rate * SENTENCE_GAP_S), dtype=np.float32)
            block_gap = np.zeros(int(sample_rate * BLOCK_GAP_S), dtype=np.float32)
            parts: list[np.ndarray] = []
            for b, block in enumerate(blocks_audio):
                if b:
                    parts.append(block_gap)
                for s, clip in enumerate(block):
                    if s:
                        parts.append(sentence_gap)
                    parts.append(clip)
            full = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
            zf.writestr("presentacion_completa.wav", encode_wav(full, sample_rate))
            duration = round(full.size / sample_rate, 1)
            manifest["full_audio"] = {"file": "presentacion_completa.wav", "duration_s": duration}
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return buffer.getvalue(), manifest


def import_zip(raw: bytes, service: SpeechService) -> tuple[PresentationData, int]:
    """Read an exported ZIP, copy clips to the cache, and return (presentation, imported clip count)."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ImportError_("El fichero no es un .zip válido.") from exc
    with zf:
        if sum(info.file_size for info in zf.infolist()) > MAX_IMPORT_BYTES:
            raise ImportError_("El .zip es demasiado grande.")
        names = set(zf.namelist())
        if "presentation.json" in names:
            try:
                data = PresentationData.model_validate_json(zf.read("presentation.json"))
            except ValueError as exc:
                raise ImportError_(f"presentation.json no es válido: {exc}") from exc
        elif "guion.md" in names:
            data = data_from_script(zf.read("guion.md").decode("utf-8"), "Presentación importada")
        else:
            raise ImportError_("El .zip no contiene presentation.json ni guion.md.")
        imported = 0
        service.settings.clips_dir.mkdir(parents=True, exist_ok=True)
        for name in names:
            m = CLIP_NAME_RE.match(name)  # allow only known paths to prevent writes outside the cache
            if not m:
                continue
            target = service.clip_path(m.group(1))
            if not target.exists():
                target.write_bytes(zf.read(name))
                imported += 1
    return data, imported
