import json
from pathlib import Path

import pytest

from app.sentences import split_sentences, spoken_sentences

CASES = json.loads((Path(__file__).parent / "fixtures" / "sentences.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["text"][:30] for c in CASES])
def test_same_cases_as_js(case):
    sentences = split_sentences(case["text"])
    assert [s.text for s in sentences] == case["sentences"]
    if "spoken" in case:
        assert [s.spoken for s in sentences] == case["spoken"]
    for s in sentences:
        assert case["text"][s.start:s.end] == s.text


def test_spoken_sentences_skips_notes():
    assert spoken_sentences("Hi. [click]\nBye.") == ["Hi.", "Bye."]
