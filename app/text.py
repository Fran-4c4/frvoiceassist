"""Split text into chunks manageable by the TTS model.

Long texts are generated in chunks (sentences grouped up to `max_chars`) and then concatenated with a short
pause. This limits VRAM use and prevents quality degradation on long texts.
"""

from __future__ import annotations

import re

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])[\"')\]]*\s+")
_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")


def normalize_text(text: str) -> str:
    """Normalize whitespace while preserving paragraph breaks (blank lines)."""
    paragraphs = [" ".join(p.split()) for p in _PARAGRAPH_SPLIT.split(text.replace("\r\n", "\n"))]
    return "\n\n".join(p for p in paragraphs if p)


def split_sentences(paragraph: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT.split(paragraph) if s.strip()]


def _split_long(sentence: str, max_chars: int) -> list[str]:
    """Split a sentence longer than `max_chars`, preferably at commas and otherwise at word boundaries."""
    if len(sentence) <= max_chars:
        return [sentence]
    clauses = [c for c in re.split(r"(?<=[,;:])\s+", sentence) if c]
    if len(clauses) > 1:
        return _pack([p for c in clauses for p in _split_long(c, max_chars)], max_chars)
    pieces: list[str] = []
    for word in sentence.split():
        while len(word) > max_chars:  # palabra absurda (URL, etc.): corte duro
            pieces.append(word[:max_chars])
            word = word[max_chars:]
        if word:
            pieces.append(word)
    return _pack(pieces, max_chars)


def _pack(pieces: list[str], max_chars: int) -> list[str]:
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if not current:
            current = piece
        elif len(current) + 1 + len(piece) <= max_chars:
            current = f"{current} {piece}"
        else:
            chunks.append(current)
            current = piece
    if current:
        chunks.append(current)
    return chunks


def chunk_text(text: str, max_chars: int) -> list[str]:
    """Return chunks of at most `max_chars` without mixing separate paragraphs."""
    if max_chars < 1:
        raise ValueError("max_chars debe ser >= 1")
    chunks: list[str] = []
    for paragraph in _PARAGRAPH_SPLIT.split(normalize_text(text)):
        pieces = [p for s in split_sentences(paragraph) for p in _split_long(s, max_chars)]
        chunks.extend(_pack(pieces, max_chars))
    return chunks
