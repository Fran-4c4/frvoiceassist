"""Sentence splitting for presentation mode.

This exactly mirrors `app/static/sentences.js`: the browser decides which sentences to play, and the server needs
the same sentences to export, import, and clean each block's audio.
Both implementations use the same cases (`tests/fixtures/sentences.json`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

TERMINATORS = ".!?…"
CLOSERS = ".!?…\"'”’)]"
_NOTE = re.compile(r"\[[^\]]*\]")


@dataclass(frozen=True)
class Sentence:
    start: int
    end: int
    text: str
    spoken: str  # spoken text excludes [notes] and is empty when the sentence contains only a note


def spoken_text(text: str) -> str:
    return " ".join(_NOTE.sub(" ", text).split())


def split_sentences(text: str) -> list[Sentence]:
    result: list[Sentence] = []
    n = len(text)

    def push(s: int, e: int) -> None:
        raw = text[s:e]
        t = raw.strip()
        if not t:
            return
        lead = len(raw) - len(raw.lstrip())
        result.append(Sentence(s + lead, s + lead + len(t), t, spoken_text(t)))

    start = i = 0
    while i < n:
        ch = text[i]
        if ch == "\n":
            push(start, i)
            start = i + 1
        elif ch in TERMINATORS:
            j = i + 1
            while j < n and text[j] in CLOSERS:
                j += 1
    # "6.3" and "e.g.x" do not split: punctuation must be followed by whitespace or end of text
            if j >= n or text[j].isspace():
                push(start, j)
                start = i = j
                continue
        i += 1
    push(start, n)
    return result


def spoken_sentences(text: str) -> list[str]:
    """Return spoken sentences (without notes) in order."""
    return [s.spoken for s in split_sentences(text) if s.spoken]
