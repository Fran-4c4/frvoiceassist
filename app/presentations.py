"""Presentations: JSON-backed sequences of blocks (title/comment plus text to speak).

    WORKSPACE_DIR/presentations/<id>.json
"""

from __future__ import annotations

import json
import re
import secrets
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")


class PresentationItem(BaseModel):
    id: str = Field(default_factory=lambda: secrets.token_hex(4), max_length=40)
    title: str = Field("", max_length=300)
    text: str = Field("", max_length=20_000)


class PresentationData(BaseModel):
    """Editable presentation content sent by the web UI when saving."""

    title: str = Field(..., min_length=1, max_length=200)
    voice: str | None = None
    language: str | None = None
    clone_mode: Literal["full", "timbre"] = "full"
    items: list[PresentationItem] = Field(default_factory=list, max_length=1000)


class Presentation(PresentationData):
    id: str
    updated_at: str


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40].rstrip("-")
    return slug or "presentacion"


class PresentationStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._lock = threading.Lock()

    def _path(self, presentation_id: str) -> Path:
        if not ID_RE.match(presentation_id or ""):
            raise KeyError(presentation_id)
        return self.root / f"{presentation_id}.json"

    def list(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        result = []
        for path in self.root.glob("*.json"):
            try:
                p = self.get(path.stem)
            except (KeyError, ValueError):
                continue
            result.append({"id": p.id, "title": p.title, "items": len(p.items), "updated_at": p.updated_at})
        return sorted(result, key=lambda p: p["updated_at"], reverse=True)

    def get(self, presentation_id: str) -> Presentation:
        path = self._path(presentation_id)
        if not path.is_file():
            raise KeyError(presentation_id)
        return Presentation.model_validate_json(path.read_text(encoding="utf-8"))

    def _write(self, presentation: Presentation) -> Presentation:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(presentation.id)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(presentation.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
        return presentation

    def create(self, data: PresentationData) -> Presentation:
        with self._lock:
            new_id = f"{_slug(data.title)}-{secrets.token_hex(3)}"
            return self._write(Presentation(id=new_id, updated_at=_now(), **data.model_dump()))

    def update(self, presentation_id: str, data: PresentationData) -> Presentation:
        with self._lock:
            self.get(presentation_id)  # raise KeyError when missing
            return self._write(Presentation(id=presentation_id, updated_at=_now(), **data.model_dump()))

    def delete(self, presentation_id: str) -> None:
        path = self._path(presentation_id)
        if not path.is_file():
            raise KeyError(presentation_id)
        path.unlink()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
