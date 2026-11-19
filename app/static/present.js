"use strict";
/*
 * Presentation mode.
 * - A presentation is a list of {id, title, text} blocks. "title" is a note for the presenter.
 * - sentences.js splits each text; every sentence is generated and cached separately (/api/clips), allowing
 *   playback to start from any sentence.
 * - A background queue prepares missing audio, prioritizing newly written text, including during playback.
 * - Playback is manual: it runs from the cursor to the end of the block, then stops at the next block.
 */
(function () {
  const { $, store, apiError } = window.FVA;
  const { splitSentences } = window.FVASentences;
  const GAP_MS = 180; // pause between sentences
  const SAVE_DELAY_MS = 700;

  const S = {
    pres: null, // current presentation
    mode: store.get("p.mode") === "present" ? "present" : "edit",
    cursor: { item: 0, sent: 0 },
    playing: null, // {item, sent} during playback, including while paused
    playToken: 0,
    waiting: false, // waiting for the next sentence to be generated
    gapTimer: null, // short pause between sentences
    gapNext: null, // {item, sent} to play after the pause
    clips: new Map(), // spoken text -> {key, url, duration_s} for the current voice/mode/language
    pending: new Set(), // texts currently being generated
    settingsGen: 0, // changes with voice/mode/language and invalidates the queue
    saveTimer: null,
    sentCache: new Map(), // item.id -> {text, sentences}
    editor: null, // inline presentation-mode editor: {kind, id, anchorId, el}
  };
  const Q = { list: [], running: false, secPerClip: 0, samples: 0, idleWaiters: [] };

  const audio = new Audio();
  const monitor = new Audio(); // default speakers ("Also play through my speakers")
  window.FVA.registerOutput(audio);
  window.FVA.present = { state: S, queue: Q, audio }; // exposed for debugging and e2e tests

  function applyPlaybackRate(rate) {
    audio.playbackRate = rate;
    monitor.playbackRate = rate;
    audio.preservesPitch = true;
    monitor.preservesPitch = true;
    $("pb-speed").value = String(rate);
  }

  $("pb-speed").addEventListener("change", (event) => window.FVA.setPlaybackRate(event.target.value));
  document.addEventListener("fva:playback-rate", (event) => applyPlaybackRate(event.detail));
  applyPlaybackRate(window.FVA.playbackRate());

  const newId = () => Math.random().toString(16).slice(2, 10);
  const jsonPost = (url, body) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  function toast(text, kind = "") {
    const el = $("p-toast");
    el.textContent = text;
    el.className = "toast " + kind;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.textContent = ""; el.className = "toast"; }, 5000);
  }

  /* =================== Sentences =================== */

  function sentencesOf(item) {
    if (!item) return [];
    const cached = S.sentCache.get(item.id);
    if (cached && cached.text === item.text) return cached.sentences;
    const s = splitSentences(item.text || "");
    S.sentCache.set(item.id, { text: item.text, sentences: s });
    return s;
  }
  const sentences = (i) => sentencesOf(S.pres && S.pres.items[i]);
  const spokenOf = (item) => sentencesOf(item).map((s) => s.spoken).filter(Boolean);

  function allSpoken() {
    if (!S.pres) return [];
    return [...new Set(S.pres.items.flatMap(spokenOf))];
  }

  function settings() {
    return { voice: $("p-voice").value || null, language: $("p-language").value || null, clone_mode: $("p-mode").value };
  }

  /* =================== Block list changes =================== */

  // Change the block list while keeping the cursor and playback attached to the same blocks
  function mutateItems(mutator) {
    const items = S.pres.items;
    const idAt = (pos) => (pos && items[pos.item] ? items[pos.item].id : null);
    const ids = { cursor: idAt(S.cursor), playing: idAt(S.playing), gap: idAt(S.gapNext) };
    mutator(items);
    const idx = (id) => items.findIndex((it) => it.id === id);
    if (S.playing) {
      const i = idx(ids.playing);
      if (i < 0) stop(); else S.playing.item = i;
    }
    if (S.gapNext) {
      const i = idx(ids.gap);
      if (i < 0) S.gapNext = null; else S.gapNext.item = i;
    }
    const c = idx(ids.cursor);
    S.cursor = c >= 0 ? { item: c, sent: S.cursor.sent }
      : { item: Math.max(0, Math.min(S.cursor.item, items.length - 1)), sent: 0 };
  }

  /* =================== Load / save =================== */

  async function loadList(selectId) {
    const list = await (await fetch("/api/presentations")).json();
    const sel = $("p-select");
    sel.innerHTML = "";
    list.forEach((p) => sel.add(new Option(`${p.title} (${p.items})`, p.id)));
    const id = selectId || store.get("p.current");
    const target = list.find((p) => p.id === id) || list[0];
    if (target) {
      sel.value = target.id;
      await open(target.id);
    } else {
      S.pres = null;
      render();
    }
  }

  async function open(id) {
    stop();
    closeEditor();
    clearQueue();
    const res = await fetch(`/api/presentations/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    S.pres = await res.json();
    store.set("p.current", id);
    S.cursor = { item: 0, sent: 0 };
    S.sentCache.clear();
    $("p-title").value = S.pres.title;
    $("p-mode").value = S.pres.clone_mode || "full";
    if (S.pres.language) $("p-language").value = S.pres.language;
    selectVoice(S.pres.voice);
    S.settingsGen++;
    render();
    await refreshClips();
    autoPrepare(allSpoken());
  }

  function selectVoice(name) {
    const sel = $("p-voice");
    if (name && [...sel.options].some((o) => o.value === name)) sel.value = name;
  }

  function scheduleSave() {
    if (!S.pres) return;
    $("p-save-state").textContent = "Cambios sin guardar…";
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(save, SAVE_DELAY_MS);
  }

  async function save() {
    if (!S.pres) return;
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    const s = settings();
    const body = {
      title: $("p-title").value.trim() || "Sin título",
      voice: s.voice, language: s.language, clone_mode: s.clone_mode,
      items: S.pres.items.map(({ id, title, text }) => ({ id, title, text })),
    };
    try {
      const res = await fetch(`/api/presentations/${encodeURIComponent(S.pres.id)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await apiError(res));
      const saved = await res.json();
      S.pres.updated_at = saved.updated_at;
      S.pres.title = saved.title;
      const opt = [...$("p-select").options].find((o) => o.value === S.pres.id);
      if (opt) opt.text = `${saved.title} (${saved.items.length})`;
      $("p-save-state").textContent = "Guardado ✓";
    } catch (err) {
      $("p-save-state").textContent = "Error al guardar: " + err.message;
    }
  }

  /* =================== Clips and preparation queue =================== */

  // Ask the server which sentences already have audio without generating anything
  async function lookup(texts) {
    texts = [...new Set(texts)].filter((t) => t && !S.clips.has(t));
    if (!texts.length || !settings().voice) return;
    try {
      const res = await jsonPost("/api/clips/lookup", { ...settings(), texts });
      if (res.ok) (await res.json()).forEach((info, i) => { if (info) S.clips.set(texts[i], info); });
    } catch { /* offline: generate during playback */ }
    paintReady();
  }

  async function refreshClips() {
    S.clips.clear();
    await lookup(allSpoken());
    paintReady();
  }

  async function ensureClip(text) {
    if (S.clips.has(text)) return S.clips.get(text);
    const gen = S.settingsGen;
    S.pending.add(text);
    paintReady();
    try {
      const res = await jsonPost("/api/clips", { ...settings(), text });
      if (!res.ok) throw new Error(await apiError(res));
      const info = await res.json();
      if (gen === S.settingsGen) S.clips.set(text, info);
      return info;
    } finally {
      S.pending.delete(text);
      paintReady();
    }
  }

  function autoPrepareOn() {
    return $("p-auto-prepare").checked;
  }

  function autoPrepare(texts, front = false) {
    if (autoPrepareOn()) enqueue(texts, front);
  }

  // Add sentences to the queue. front=true prepares them before the rest (for example, a new block)
  function enqueue(texts, front = false) {
    if (!settings().voice) return;
    const wanted = [...new Set(texts)].filter((t) => t && !S.clips.has(t) && !S.pending.has(t));
    if (!wanted.length) return;
    const rest = Q.list.filter((t) => !wanted.includes(t));
    Q.list = front ? wanted.concat(rest) : rest.concat(wanted);
    paintReady();
    runQueue();
  }

  function clearQueue() {
    Q.list = [];
    paintReady();
  }

  async function runQueue() {
    if (Q.running) return;
    Q.running = true;
    paintReady();
    let lastError = null;
    while (Q.list.length) {
      const text = Q.list.shift();
      if (S.clips.has(text) || !allSpoken().includes(text)) continue;
      const t0 = performance.now();
      try {
        const info = await ensureClip(text);
        if (!info.cached) { // moving average of generation time, used to estimate remaining work
          const sec = (performance.now() - t0) / 1000;
          Q.secPerClip = Q.samples ? Q.secPerClip * 0.7 + sec * 0.3 : sec;
          Q.samples++;
        }
      } catch (err) {
        lastError = err.message;
        if (/voz|modelo/i.test(err.message)) { Q.list = []; break; } // retrying will not fix this error
      }
    }
    Q.running = false;
    paintReady();
    Q.idleWaiters.splice(0).forEach((resolve) => resolve());
    if (lastError) toast("Error preparando el audio: " + lastError, "err");
  }

  function queueIdle() {
    return Q.running || Q.list.length ? new Promise((resolve) => Q.idleWaiters.push(resolve)) : Promise.resolve();
  }

  // Delete server-side audio for sentences no longer used after editing or deleting text
  async function releaseTexts(texts) {
    const inUse = new Set(allSpoken());
    const keys = [];
    texts.forEach((t) => {
      if (inUse.has(t)) return;
      const info = S.clips.get(t);
      if (info) keys.push(info.key);
      S.clips.delete(t);
    });
    Q.list = Q.list.filter((t) => inUse.has(t));
    if (keys.length) {
    try { await jsonPost("/api/clips/release", { keys }); } catch { /* non-critical */ }
    }
  }

  /* =================== State: progress and markers =================== */

  function blockStatus(item) {
    const texts = spokenOf(item);
    const ready = texts.filter((t) => S.clips.has(t)).length;
    const busy = texts.some((t) => S.pending.has(t) || Q.list.includes(t));
    return { total: texts.length, ready, busy };
  }

  function badgeFor(item) {
    const st = blockStatus(item);
    if (!st.total) return { text: "", cls: "" };
    if (st.ready === st.total) return { text: "✓ listo", cls: "ok" };
    if (st.busy) return { text: `⏳ ${st.ready}/${st.total}`, cls: "busy" };
    return { text: `○ ${st.ready}/${st.total}`, cls: "todo" };
  }

  function paintReady() {
    if (!S.pres) return;
    updateProgress();
    document.querySelectorAll("[data-badge-for]").forEach((el) => {
      const item = S.pres.items.find((it) => it.id === el.dataset.badgeFor);
      const b = item ? badgeFor(item) : { text: "", cls: "" };
      el.textContent = b.text;
      el.className = "badge " + b.cls;
    });
    if (S.mode !== "present") return;
    document.querySelectorAll("#p-present-list .sent").forEach((el) => {
      const s = sentences(+el.dataset.item)[+el.dataset.sent];
      if (!s || !s.spoken) return;
      el.classList.toggle("unready", !S.clips.has(s.spoken));
      el.classList.toggle("generating", S.pending.has(s.spoken));
    });
  }

  function updateProgress() {
    const texts = allSpoken();
    const ready = texts.filter((t) => S.clips.has(t)).length;
    const secs = texts.reduce((acc, t) => acc + (S.clips.get(t)?.duration_s || 0), 0);
    const busy = Q.running || Q.list.length > 0;
    let msg = texts.length ? `${ready}/${texts.length} frases listas` : "";
    if (secs) msg += ` · ${Math.round((secs / 60) * 10) / 10} min de audio`;
    if (busy) {
      const left = texts.length - ready;
      const eta = Q.secPerClip ? ` · ~${Math.max(1, Math.round((left * Q.secPerClip) / 60))} min` : "";
      msg = `Preparando… ${msg}${eta}`;
    }
    $("p-progress").textContent = msg;
    $("p-prepare").textContent = busy ? "Detener preparación" : "Preparar audio";
  }

  /* =================== Rendering =================== */

  function render() {
    const has = !!S.pres;
    $("p-empty").classList.toggle("hidden", has);
    ["p-settings", "p-toolbar"].forEach((id) => $(id).classList.toggle("hidden", !has));
    ["p-delete", "p-export-md", "p-export-zip"].forEach((id) => { $(id).disabled = !has; });
    const editing = S.mode === "edit";
    $("p-mode-edit").classList.toggle("active", editing);
    $("p-mode-present").classList.toggle("active", !editing);
    $("p-edit-list").classList.toggle("hidden", !editing || !has);
    $("p-edit-actions").classList.toggle("hidden", !editing || !has);
    $("p-present-list").classList.toggle("hidden", editing || !has);
    $("p-bar").classList.toggle("hidden", editing || !has);
    if (!has) return;
    if (editing) renderEdit(); else renderPresent();
    paintReady();
  }

  function badgeEl(item) {
    const b = document.createElement("span");
    b.dataset.badgeFor = item.id;
    b.className = "badge";
    return b;
  }

  function renderEdit() {
    const list = $("p-edit-list");
    list.innerHTML = "";
    S.pres.items.forEach((item, i) => {
      const card = document.createElement("div");
      card.className = "card block-edit";
      card.dataset.id = item.id;
      card.innerHTML = `
        <div class="row tight block-head">
          <span class="block-num"></span>
          <input class="block-title" maxlength="300" placeholder="Título / comentario (no se lee)">
          <span class="badge-slot"></span>
          <button class="small-btn up" title="Subir">↑</button>
          <button class="small-btn down" title="Bajar">↓</button>
          <button class="small-btn add" title="Insertar bloque debajo">+</button>
          <button class="small-btn del" title="Eliminar bloque y su audio">✕</button>
        </div>
        <textarea class="block-text" rows="3" placeholder="Texto que se leerá (en inglés). [Notas entre corchetes no se leen]"></textarea>`;
      card.querySelector(".block-num").textContent = i + 1;
      card.querySelector(".badge-slot").replaceWith(badgeEl(item));
      const title = card.querySelector(".block-title");
      const text = card.querySelector(".block-text");
      title.value = item.title || "";
      text.value = item.text || "";
      let before = [];
      title.addEventListener("input", () => { item.title = title.value; scheduleSave(); });
      text.addEventListener("focus", () => { before = spokenOf(item); });
      text.addEventListener("input", () => { item.text = text.value; autoGrow(text); scheduleSave(); });
      text.addEventListener("change", () => textChanged(item, before));
      card.querySelector(".up").addEventListener("click", () => move(i, -1));
      card.querySelector(".down").addEventListener("click", () => move(i, 1));
      card.querySelector(".add").addEventListener("click", () => addItem(i + 1));
      card.querySelector(".del").addEventListener("click", () => deleteItem(item.id));
      list.appendChild(card);
    });
    // Heights can be measured only after the textareas are in the page
    requestAnimationFrame(() => list.querySelectorAll(".block-text").forEach(autoGrow));
  }

      // After editing a block, release removed sentence audio and prepare new sentences
  async function textChanged(item, before) {
    const now = spokenOf(item);
    await releaseTexts(before.filter((t) => !now.includes(t)));
    await lookup(now);
    autoPrepare(now);
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight + 2, 70) + "px";
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= S.pres.items.length) return;
    mutateItems((items) => { [items[i], items[j]] = [items[j], items[i]]; });
    scheduleSave(); render();
  }

  function addItem(at) {
    const item = { id: newId(), title: "", text: "" };
    mutateItems((items) => items.splice(at, 0, item));
    scheduleSave(); render();
    const input = document.querySelector(`#p-edit-list [data-id="${item.id}"] .block-title`);
    if (input) input.focus();
  }

  async function deleteItem(id) {
    const index = S.pres.items.findIndex((it) => it.id === id);
    const item = S.pres.items[index];
    if (!item) return;
    if ((item.text || item.title) && !confirm(`¿Eliminar el bloque ${index + 1}${item.title ? ` (${item.title})` : ""} y su audio?`)) return;
    if (S.editor && S.editor.id === id) closeEditor();
      await save(); // the server must know about the block before deleting it
    let deleted = 0;
    const res = await fetch(`/api/presentations/${encodeURIComponent(S.pres.id)}/items/${encodeURIComponent(id)}`,
      { method: "DELETE" });
    if (res.ok) deleted = (await res.json()).deleted_clips;
    const gone = spokenOf(item);
    mutateItems((items) => items.splice(items.findIndex((it) => it.id === id), 1));
    const inUse = new Set(allSpoken());
    gone.forEach((t) => { if (!inUse.has(t)) S.clips.delete(t); });
    Q.list = Q.list.filter((t) => inUse.has(t));
    render();
    if (S.mode === "present") setCursor(S.cursor.item, S.cursor.sent, false);
    toast(`Bloque eliminado${deleted ? ` · ${deleted} audio${deleted > 1 ? "s" : ""} borrado${deleted > 1 ? "s" : ""}` : ""}.`);
  }

  function renderPresent() {
    const list = $("p-present-list");
    list.innerHTML = "";
    S.pres.items.forEach((item, i) => {
      const card = document.createElement("div");
      card.className = "card block-present";
      card.dataset.item = i;
      card.dataset.id = item.id;
      const head = document.createElement("div");
      head.className = "block-ref";
      head.innerHTML = `<span class="block-num"></span><span class="block-title-text"></span><span class="badge-slot"></span>
        <span class="block-actions">
          <button class="small-btn edit" title="Editar este bloque">✎</button>
          <button class="small-btn add" title="Añadir un bloque debajo (N)">+</button>
          <button class="small-btn del" title="Eliminar bloque y su audio">✕</button>
        </span>`;
      head.querySelector(".block-num").textContent = i + 1;
      head.querySelector(".block-title-text").textContent = item.title || "";
      head.querySelector(".badge-slot").replaceWith(badgeEl(item));
      head.querySelector(".edit").addEventListener("click", (e) => { e.currentTarget.blur(); openEditor("edit", item.id); });
      head.querySelector(".add").addEventListener("click", (e) => { e.currentTarget.blur(); openEditor("new", item.id); });
      head.querySelector(".del").addEventListener("click", (e) => { e.currentTarget.blur(); deleteItem(item.id); });
      card.appendChild(head);
      const body = document.createElement("p");
      body.className = "block-body";
      const sents = sentencesOf(item);
      if (!sents.length) body.innerHTML = '<span class="muted">(bloque vacío)</span>';
      sents.forEach((s, k) => {
        const span = document.createElement("span");
        span.className = "sent" + (s.spoken ? "" : " note");
        span.dataset.item = i;
        span.dataset.sent = k;
    // [Notes] appear in gray within the sentence and are not spoken
        s.text.split(/(\[[^\]]*\])/).forEach((part) => {
          if (!part) return;
          if (/^\[[^\]]*\]$/.test(part)) {
            const note = document.createElement("span");
            note.className = "note-inline";
            note.textContent = part;
            span.appendChild(note);
          } else {
            span.appendChild(document.createTextNode(part));
          }
        });
        span.addEventListener("click", () => onSentenceClick(i, k));
        span.addEventListener("dblclick", () => playFrom(i, k));
        body.appendChild(span);
        body.appendChild(document.createTextNode(" "));
      });
      card.appendChild(body);
      list.appendChild(card);
    });
    placeEditor();
    paintCursor(false);
  }

  /* =================== Inline editor (presentation mode) =================== */

  // kind "new": new block below anchorId; kind "edit": edit the anchorId block
  function openEditor(kind, anchorId) {
    closeEditor();
    const item = S.pres.items.find((it) => it.id === anchorId);
    const el = document.createElement("div");
    el.className = "card block-present editing";
    el.innerHTML = `
      <div class="row tight block-head">
        <span class="block-num">${kind === "new" ? "+" : "✎"}</span>
        <input class="block-title" maxlength="300" placeholder="Título / comentario (no se lee)">
      </div>
      <textarea class="block-text" rows="3" placeholder="Texto en inglés que quieres decir…"></textarea>
      <div class="row tight">
        <button class="primary save">${kind === "new" ? "Añadir y preparar" : "Guardar y preparar"}</button>
        <button class="cancel">Cancelar</button>
        <span class="muted small">Ctrl+Enter guarda · Esc cancela · la reproducción no se interrumpe</span>
      </div>`;
    const title = el.querySelector(".block-title");
    const text = el.querySelector(".block-text");
    if (kind === "edit" && item) { title.value = item.title || ""; text.value = item.text || ""; }
    text.addEventListener("input", () => autoGrow(text));
    const onKey = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEditor(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeEditor(); }
    };
    title.addEventListener("keydown", onKey);
    text.addEventListener("keydown", onKey);
    el.querySelector(".save").addEventListener("click", saveEditor);
    el.querySelector(".cancel").addEventListener("click", closeEditor);
    S.editor = { kind, anchorId, el };
    placeEditor();
    text.focus(); // immediate focus sends subsequent typing to the editor instead of shortcuts
    requestAnimationFrame(() => autoGrow(text));
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function placeEditor() {
    if (!S.editor) return;
    const { kind, anchorId, el } = S.editor;
    const anchor = document.querySelector(`#p-present-list .block-present[data-id="${anchorId}"]`);
    const list = $("p-present-list");
    if (!anchor) { list.appendChild(el); return; }
    if (kind === "edit") { anchor.classList.add("hidden"); anchor.after(el); } else anchor.after(el);
  }

  function closeEditor() {
    if (!S.editor) return;
    S.editor.el.remove();
    document.querySelectorAll("#p-present-list .block-present.hidden").forEach((el) => el.classList.remove("hidden"));
    S.editor = null;
  }

  async function saveEditor() {
    if (!S.editor) return;
    const { kind, anchorId, el } = S.editor;
    const title = el.querySelector(".block-title").value.trim();
    const text = el.querySelector(".block-text").value.trim();
    if (!text && !title) { closeEditor(); return; }
    let item;
    let before = [];
    if (kind === "new") {
      item = { id: newId(), title, text };
      const at = S.pres.items.findIndex((it) => it.id === anchorId) + 1;
      mutateItems((items) => items.splice(at > 0 ? at : items.length, 0, item));
      // If nothing is playing, move the cursor to the new block so Space plays it as soon as it is ready
      if (!isPlayingNow()) S.cursor = { item: S.pres.items.indexOf(item), sent: 0 };
    } else {
      item = S.pres.items.find((it) => it.id === anchorId);
      if (!item) { closeEditor(); return; }
      before = spokenOf(item);
      if (S.playing && S.pres.items[S.playing.item] === item) stop(); // its sentences are changing
      item.title = title;
      item.text = text;
    }
    closeEditor();
    renderPresent();
    paintReady();
    const card = document.querySelector(`#p-present-list .block-present[data-id="${item.id}"]`);
    if (card) { card.classList.add("flash"); card.scrollIntoView({ block: "center", behavior: "smooth" }); }
    await save();
    const now = spokenOf(item);
    await releaseTexts(before.filter((t) => !now.includes(t)));
    await lookup(now);
    enqueue(now, true); // prepare new text first even when automatic preparation is disabled
    toast(kind === "new" ? "Bloque añadido: preparando su audio…" : "Bloque actualizado: preparando su audio…");
  }

  /* =================== Cursor and playback =================== */

  function sentEl(i, k) {
    return document.querySelector(`#p-present-list .sent[data-item="${i}"][data-sent="${k}"]`);
  }

  function paintCursor(scroll = true) {
    document.querySelectorAll("#p-present-list .sent.cursor, #p-present-list .sent.playing")
      .forEach((el) => el.classList.remove("cursor", "playing"));
    document.querySelectorAll("#p-present-list .block-present.current")
      .forEach((el) => el.classList.remove("current"));
    const block = document.querySelector(`#p-present-list .block-present[data-item="${S.cursor.item}"]`);
    if (block) block.classList.add("current");
    const el = sentEl(S.cursor.item, S.cursor.sent);
    if (el) {
      el.classList.add(S.playing && !audio.paused ? "playing" : "cursor");
      if (scroll) el.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (block && scroll) {
      block.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    updateStatus();
  }

  function updateStatus() {
    if (!S.pres) return;
    const total = S.pres.items.length;
    const n = sentences(S.cursor.item).length || 1;
    let state = "";
    if (S.playing) state = S.waiting ? "Generando…" : (audio.paused && !S.gapTimer ? "En pausa" : "Sonando");
    $("pb-status").textContent = total
      ? `Bloque ${Math.min(S.cursor.item + 1, total)}/${total} · frase ${Math.min(S.cursor.sent + 1, n)}/${n}` +
        (state ? ` · ${state}` : "")
      : "";
    $("pb-play").textContent = isPlayingNow() ? "⏸" : "▶";
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }

  function updateSeek() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const current = duration ? Math.min(audio.currentTime, duration) : 0;
    const seek = $("pb-seek");
    seek.disabled = !duration;
    seek.value = duration ? String(Math.round(current / duration * 1000)) : "0";
    $("pb-time").textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  }

  function resetSeek() {
    $("pb-seek").disabled = true;
    $("pb-seek").value = "0";
    $("pb-time").textContent = "0:00 / 0:00";
  }

  $("pb-seek").addEventListener("input", (event) => {
    if (!Number.isFinite(audio.duration) || !audio.duration) return;
    audio.currentTime = Number(event.target.value) / 1000 * audio.duration;
    if (monitor.currentSrc) monitor.currentTime = audio.currentTime;
    updateSeek();
  });

  function setCursor(item, sent, scroll = true) {
    if (!S.pres || !S.pres.items.length) return;
    item = Math.max(0, Math.min(item, S.pres.items.length - 1));
    const n = sentences(item).length;
    sent = Math.max(0, Math.min(sent, Math.max(n - 1, 0)));
    S.cursor = { item, sent };
    paintCursor(scroll);
  }

  function stopAudio() {
    clearTimeout(S.gapTimer);
    S.gapTimer = null;
    S.gapNext = null;
    S.waiting = false;
    audio.pause();
    monitor.pause();
    audio.removeAttribute("src");
    resetSeek();
  }

  function stop() {
    S.playToken++;
    S.playing = null;
    stopAudio();
    paintCursor(false);
  }

  async function playFrom(item, sent) {
    if (!S.pres) return;
    const token = ++S.playToken;
    stopAudio();
    const sents = sentences(item);
    let k = sent;
    while (k < sents.length && !sents[k].spoken) k++; // skip [notes]
    if (k >= sents.length) { finishItem(item, token); return; }
    S.playing = { item, sent: k };
    setCursor(item, k);
    S.waiting = true;
    updateStatus();
    let info;
    try {
      info = await ensureClip(sents[k].spoken);
    } catch (err) {
      if (token === S.playToken) { stop(); toast("No se pudo generar la frase: " + err.message, "err"); }
      return;
    }
    if (token !== S.playToken) return; // the user took another action during generation
    S.waiting = false;
    audio.src = info.url;
    applyPlaybackRate(window.FVA.playbackRate());
    try {
      await audio.play();
      if (window.FVA.monitorWanted()) { monitor.src = info.url; monitor.play().catch(() => {}); }
    } catch (err) {
      // AbortError means the user paused or changed sentences before playback began; it is not a failure
      if (err.name !== "AbortError" && token === S.playToken) {
        stop();
        toast("No se pudo reproducir el audio: " + err.message, "err");
      }
      return;
    }
    paintCursor(false);
    // Move the rest of this block to the front of the queue
    enqueue(sents.slice(k + 1).map((s) => s.spoken).filter(Boolean), true);
  }

  function finishItem(item, token) {
    if (token !== S.playToken) return;
    S.playing = null;
    const nextItem = item + 1;
    if (nextItem < S.pres.items.length) {
      setCursor(nextItem, 0);
      if ($("pb-auto").checked) playFrom(nextItem, 0);
    } else {
      paintCursor(false);
    }
  }

  audio.addEventListener("ended", () => {
    if (!S.playing) return;
    const token = S.playToken;
    const { item, sent } = S.playing;
    S.gapNext = sent + 1 < sentences(item).length ? { item, sent: sent + 1 } : null;
    S.gapTimer = setTimeout(() => {
      S.gapTimer = null;
      if (token !== S.playToken) return;
      if (S.gapNext) playFrom(S.gapNext.item, S.gapNext.sent);
      else finishItem(S.playing ? S.playing.item : item, token); // updated index if blocks moved
    }, GAP_MS);
  });
  audio.addEventListener("play", () => paintCursor(false));
  audio.addEventListener("pause", () => paintCursor(false));
  audio.addEventListener("loadedmetadata", updateSeek);
  audio.addEventListener("durationchange", updateSeek);
  audio.addEventListener("timeupdate", updateSeek);
  audio.addEventListener("emptied", updateSeek);

  function togglePlay() {
    if (!S.pres) return;
    if (S.gapTimer) {
    // A pause requested between sentences stops playback and leaves the cursor on the next one
      const next = S.gapNext;
      const item = S.playing.item;
      stop();
      if (next) setCursor(next.item, next.sent);
      else if (item + 1 < S.pres.items.length) setCursor(item + 1, 0);
      return;
    }
    if (S.waiting) { stop(); return; } // cancel when pressed while the sentence is being generated
    const sameSpot = S.playing && S.playing.item === S.cursor.item && S.playing.sent === S.cursor.sent;
    if (S.playing && !audio.paused) {
      audio.pause(); monitor.pause();
    } else if (sameSpot && audio.src && audio.paused) {
      audio.play().catch(() => {});
      if (window.FVA.monitorWanted()) { monitor.currentTime = audio.currentTime; monitor.play().catch(() => {}); }
    } else {
      playFrom(S.cursor.item, S.cursor.sent);
    }
  }

  function isPlayingNow() {
    return !!S.playing && (S.waiting || !!S.gapTimer || !audio.paused);
  }

  function goSentence(delta) {
    const { item, sent } = S.cursor;
    let i = item, k = sent + delta;
    if (k < 0) { i = item - 1; if (i < 0) return; k = Math.max(sentences(i).length - 1, 0); }
    if (k >= sentences(i).length) { i = item + 1; k = 0; if (i >= S.pres.items.length) return; }
    jump(i, k);
  }

  function goItem(delta) {
    const { item, sent } = S.cursor;
    if (delta < 0 && sent > 0 && !isPlayingNow()) return jump(item, 0); // first jump: start of block
    jump(item + delta, 0);
  }

  function jump(item, sent) {
    if (!S.pres || item < 0 || item >= S.pres.items.length) return;
    if (isPlayingNow()) playFrom(item, sent);
    else {
      if (S.playing) stop();
      setCursor(item, sent);
    }
  }

  function onSentenceClick(i, k) {
    if (isPlayingNow()) playFrom(i, k);
    else {
      if (S.playing) stop();
      setCursor(i, k, false);
    }
  }

  /* =================== Presentations: create, delete, import, export =================== */

  function setMode(mode) {
    if (mode === S.mode) return;
    if (mode === "edit") { stop(); closeEditor(); }
    S.mode = mode;
    store.set("p.mode", mode);
    render();
    if (mode === "present") setCursor(S.cursor.item, S.cursor.sent);
  }

  async function createPresentation() {
    const title = prompt("Título de la nueva presentación:", "Nueva presentación");
    if (!title) return;
    const res = await jsonPost("/api/presentations", { title, ...settings(), items: [{ title: "", text: "" }] });
    if (!res.ok) return alert(await apiError(res));
    const p = await res.json();
    S.mode = "edit";
    store.set("p.mode", "edit");
    await loadList(p.id);
  }

  async function deletePresentation() {
    if (!S.pres || !confirm(`¿Eliminar la presentación '${S.pres.title}' y su audio?`)) return;
    stop();
    clearQueue();
    await fetch(`/api/presentations/${encodeURIComponent(S.pres.id)}`, { method: "DELETE" });
    store.set("p.current", "");
    await loadList();
  }

  function pasteScript() {
    const dlg = $("import-dialog");
    $("import-text").value = "";
    $("import-replace").checked = !S.pres.items.some((it) => it.text || it.title);
    dlg.returnValue = "";
    dlg.showModal();
    dlg.addEventListener("close", async function onClose() {
      dlg.removeEventListener("close", onClose);
      if (dlg.returnValue !== "ok") return;
      const res = await jsonPost("/api/script/parse", { text: $("import-text").value });
      if (!res.ok) return toast(await apiError(res), "err");
      const { items } = await res.json();
      if (!items.length) return toast("El guion no contiene ningún bloque.", "err");
      const replaced = $("import-replace").checked ? S.pres.items.flatMap(spokenOf) : [];
      stop();
      S.pres.items = $("import-replace").checked ? items : S.pres.items.concat(items);
      S.cursor = { item: 0, sent: 0 };
      S.sentCache.clear();
      render();
      await save();
      await releaseTexts(replaced);
      await lookup(allSpoken());
      autoPrepare(allSpoken());
      toast(`${items.length} bloques importados.`);
    });
  }

  async function importFile(file) {
    const form = new FormData();
    form.append("file", file, file.name);
    toast("Importando…");
    const res = await fetch("/api/presentations/import", { method: "POST", body: form });
    if (!res.ok) return toast("No se pudo importar: " + (await apiError(res)), "err");
    const { presentation, imported_clips } = await res.json();
    await loadList(presentation.id);
    toast(`Importada «${presentation.title}»` + (imported_clips ? ` con ${imported_clips} audios ya preparados.` : "."));
  }

  function download(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function exportMarkdown() {
    await save();
    download(`/api/presentations/${encodeURIComponent(S.pres.id)}/export.md`);
  }

  async function exportZip() {
    await save();
    const missing = allSpoken().filter((t) => !S.clips.has(t));
    if (missing.length) {
      const eta = Q.secPerClip ? ` (~${Math.max(1, Math.round((missing.length * Q.secPerClip) / 60))} min)` : "";
      const prepareFirst = confirm(
        `Faltan ${missing.length} frases por preparar${eta}.\n\n` +
        "Aceptar: prepararlas y exportar al terminar.\n" +
        "Cancelar: exportar ya, sin esas frases ni el WAV completo.");
      if (prepareFirst) {
        enqueue(missing);
        toast("Preparando el audio que falta; la descarga empezará al terminar…");
        await queueIdle();
      }
    }
    download(`/api/presentations/${encodeURIComponent(S.pres.id)}/export.zip`);
  }

  /* =================== Shortcuts =================== */

  document.addEventListener("keydown", (e) => {
    if (window.FVA.currentTab() !== "present" || !S.pres) return;
    if (document.querySelector("dialog[open]")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || e.target.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key;
    if (key === "?") { $("help-dialog").showModal(); e.preventDefault(); return; }
    if (key === "e" || key === "E") { setMode("edit"); e.preventDefault(); return; }
    if (key === "p" || key === "P") { setMode("present"); e.preventDefault(); return; }
    if (S.mode !== "present") return;
    const current = () => S.pres.items[S.cursor.item];
    const actions = {
      " ": togglePlay,
      Enter: () => playFrom(S.cursor.item, S.cursor.sent),
      Escape: stop,
      ArrowRight: () => goSentence(1),
      ArrowLeft: () => goSentence(-1),
      ArrowDown: () => goItem(1),
      PageDown: () => goItem(1),
      ArrowUp: () => goItem(-1),
      PageUp: () => goItem(-1),
      Home: () => jump(0, 0),
      End: () => jump(S.pres.items.length - 1, 0),
      n: () => current() && openEditor("new", current().id),
      N: () => current() && openEditor("new", current().id),
    };
    if (actions[key]) {
      e.preventDefault();
    if (e.target instanceof HTMLButtonElement) e.target.blur(); // prevent Space from pressing the focused button
      actions[key]();
    }
  });

  /* =================== UI events =================== */

  $("p-select").addEventListener("change", async (e) => { await save(); open(e.target.value); });
  $("p-new").addEventListener("click", createPresentation);
  $("p-delete").addEventListener("click", deletePresentation);
  $("p-open-file").addEventListener("click", () => $("p-file").click());
  $("p-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) importFile(file);
  });
  $("p-export-md").addEventListener("click", exportMarkdown);
  $("p-export-zip").addEventListener("click", exportZip);
  $("p-title").addEventListener("input", scheduleSave);
  ["p-voice", "p-mode", "p-language"].forEach((id) => $(id).addEventListener("change", async () => {
    stop();
    clearQueue();
    S.settingsGen++;
    scheduleSave();
    await refreshClips();
    autoPrepare(allSpoken());
  }));
  $("p-mode-edit").addEventListener("click", () => setMode("edit"));
  $("p-mode-present").addEventListener("click", () => setMode("present"));
  $("p-add").addEventListener("click", () => addItem(S.pres.items.length));
  $("p-import").addEventListener("click", pasteScript);
  $("p-prepare").addEventListener("click", async () => {
    if (Q.running || Q.list.length) { clearQueue(); return; }
    if (!settings().voice) { alert("Primero crea tu voz en la pestaña 'Mi voz'."); return; }
    await save();
    enqueue(allSpoken());
  });
  $("p-auto-prepare").checked = store.get("p.autoprep") !== "0";
  $("p-auto-prepare").addEventListener("change", (e) => {
    store.set("p.autoprep", e.target.checked ? "1" : "0");
    if (e.target.checked) enqueue(allSpoken());
  });
  $("p-help").addEventListener("click", () => $("help-dialog").showModal());
  $("pb-play").addEventListener("click", togglePlay);
  $("pb-stop").addEventListener("click", stop);
  $("pb-prev").addEventListener("click", () => goSentence(-1));
  $("pb-next").addEventListener("click", () => goSentence(1));
  $("pb-prev-item").addEventListener("click", () => goItem(-1));
  $("pb-next-item").addEventListener("click", () => goItem(1));
  $("pb-add").addEventListener("click", () => { const it = S.pres.items[S.cursor.item]; if (it) openEditor("new", it.id); });
  $("pb-auto").checked = store.get("p.auto") === "1";
  $("pb-auto").addEventListener("change", (e) => store.set("p.auto", e.target.checked ? "1" : "0"));
  window.addEventListener("beforeunload", () => { if (S.saveTimer) save(); });

  document.addEventListener("fva:voices", async (e) => {
    const sel = $("p-voice");
    const prev = sel.value || (S.pres && S.pres.voice);
    sel.innerHTML = "";
    e.detail.forEach((v) => sel.add(new Option(v.name, v.name)));
    if (!e.detail.length) sel.add(new Option("— sin voces —", ""));
    selectVoice(prev);
    if (!S.pres) return;
    await refreshClips();
    autoPrepare(allSpoken());
  });

  /* =================== Startup =================== */

  (async function init() {
    const langs = await (await fetch("/api/languages")).json();
    langs.forEach((l) => $("p-language").add(new Option(l, l)));
    $("p-language").value = "English";
    await loadList();
  })();
})();
