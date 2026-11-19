"use strict";
/*
 * Split text into sentences for presentation mode.
 * Each sentence stores its source position and spoken text (without [bracketed notes]).
 * Used in the browser (window.FVASentences) and in tests (node --test).
 */
(function (root) {
  const TERMINATORS = ".!?…";
  const CLOSERS = ".!?…\"'”’)]";

  function spokenText(t) {
    return t.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  }

  function splitSentences(text) {
    const res = [];
    const n = text.length;
    let start = 0;
    const push = (s, e) => {
      const raw = text.slice(s, e);
      const t = raw.trim();
      if (!t) return;
      const lead = raw.length - raw.trimStart().length;
      res.push({ start: s + lead, end: s + lead + t.length, text: t, spoken: spokenText(t) });
    };
    for (let i = 0; i < n; i++) {
      const ch = text[i];
      if (ch === "\n") { push(start, i); start = i + 1; continue; }
      if (TERMINATORS.includes(ch)) {
        let j = i + 1;
        while (j < n && CLOSERS.includes(text[j])) j++;
    // "6.3" and "e.g.x" do not split: punctuation must be followed by whitespace or end of text
        if (j >= n || /\s/.test(text[j])) { push(start, j); start = j; i = j - 1; }
      }
    }
    push(start, n);
    return res;
  }

  const api = { splitSentences, spokenText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FVASentences = api;
})(typeof window !== "undefined" ? window : globalThis);
