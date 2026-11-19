import pytest

from app.text import chunk_text, normalize_text, split_sentences


def test_normalize_collapses_spaces_and_keeps_paragraphs():
    assert normalize_text("Hello   world.\r\n\r\n\n  Second\tline ") == "Hello world.\n\nSecond line"


def test_split_sentences():
    assert split_sentences("One. Two? Three! Four") == ["One.", "Two?", "Three!", "Four"]


def test_short_text_is_single_chunk():
    assert chunk_text("Hello there. How are you?", 100) == ["Hello there. How are you?"]


def test_chunks_respect_max_length_and_preserve_words():
    text = " ".join(f"Sentence number {i} is here." for i in range(30))
    chunks = chunk_text(text, 80)
    assert len(chunks) > 1
    assert all(len(c) <= 80 for c in chunks)
    assert " ".join(chunks).split() == text.split()


def test_long_sentence_is_split_by_commas_then_words():
    sentence = ", ".join(["a fairly long clause with several words"] * 6) + "."
    chunks = chunk_text(sentence, 50)
    assert all(len(c) <= 50 for c in chunks)
    assert " ".join(chunks).split() == sentence.split()


def test_paragraphs_are_not_merged():
    assert chunk_text("First paragraph.\n\nSecond paragraph.", 500) == ["First paragraph.", "Second paragraph."]


def test_giant_word_is_hard_split():
    chunks = chunk_text("x" * 25, 10)
    assert chunks == ["x" * 10, "x" * 10, "x" * 5]


def test_empty_text():
    assert chunk_text("   \n\n ", 50) == []


def test_invalid_max_chars():
    with pytest.raises(ValueError):
        chunk_text("hi", 0)
