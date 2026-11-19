// Presentation-mode sentence-splitting tests. Run: node --test tests/js/sentences.test.js
// Uses the same cases as tests/test_sentences.py to ensure JS and Python split identically.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { splitSentences, spokenText } = require("../../app/static/sentences.js");

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "sentences.json"), "utf8"));

for (const c of CASES) {
  test(`mismos casos que Python: ${JSON.stringify(c.text).slice(0, 40)}`, () => {
    const sentences = splitSentences(c.text);
    assert.deepEqual(sentences.map((s) => s.text), c.sentences);
    if (c.spoken) assert.deepEqual(sentences.map((s) => s.spoken), c.spoken);
    for (const s of sentences) assert.equal(c.text.slice(s.start, s.end), s.text);
  });
}

test("spokenText quita las notas", () => {
  assert.equal(spokenText("We [quickly] move on."), "We move on.");
});
