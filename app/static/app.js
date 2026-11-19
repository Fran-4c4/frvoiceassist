"use strict";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

function playbackRate() {
  const saved = Number(store.get("playbackRate"));
  return PLAYBACK_RATES.includes(saved) ? saved : 1;
}

function setPlaybackRate(value) {
  const rate = Number(value);
  if (!PLAYBACK_RATES.includes(rate)) return playbackRate();
  store.set("playbackRate", String(rate));
  document.dispatchEvent(new CustomEvent("fva:playback-rate", { detail: rate }));
  return rate;
}

function setMsg(el, text, kind = "") {
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

async function apiError(res) {
  try {
    const body = await res.json();
    return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/* ---------------- Tabs ---------------- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  store.set("tab", name);
  document.dispatchEvent(new CustomEvent("fva:tab", { detail: name }));
}
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
if (store.get("tab") && document.getElementById("tab-" + store.get("tab"))) showTab(store.get("tab"));

/* ---------------- API shared with present.js ---------------- */
// Cloned-voice elements that should play through the selected device (for example, CABLE Input).
// When supported by the browser, FVARouter handles them and also mixes in the real microphone.
const router = window.FVARouter;
const audioOutputs = []; // used only without mixing (setSinkId on each element)
window.FVA = {
  $, store, setMsg, apiError, showTab,
  currentTab: () => store.get("tab") || "present",
  registerOutput(el) {
    if (router.attach(el)) return;
    audioOutputs.push(el);
    const sink = document.getElementById("sink").value;
    if (sink && el.setSinkId) el.setSinkId(sink).catch(() => {});
  },
  // true when audio should also play through the speakers (monitor)
  monitorWanted: () => document.getElementById("monitor-enabled").checked && !!document.getElementById("sink").value,
  playbackRate,
  setPlaybackRate,
};

/* ---------------- Model state ---------------- */
let health = null;
async function pollHealth() {
  try {
    const res = await fetch("/api/health");
    health = await res.json();
    const pill = $("status");
    pill.className = "pill pill-" + health.status;
    pill.textContent = { ready: "Listo", loading: "Cargando modelo…", error: "Error" }[health.status] + ` · ${health.engine}`;
    pill.title = health.error || health.model;
    updateCharCount();
    if (health.status === "loading") setTimeout(pollHealth, 3000);
  } catch {
    setTimeout(pollHealth, 5000);
  }
}

/* ---------------- Voice quality report ---------------- */
const VERDICT = { ok: "✔ Grabación correcta", warn: "⚠ Mejorable", bad: "✖ Conviene repetirla" };

function renderReport(report) {
  const box = document.createElement("div");
  if (!report) {
    box.className = "report";
    box.innerHTML = '<span class="muted">Sin comprobar todavía.</span>';
    return box;
  }
  const m = report.metrics || {};
  box.className = "report " + report.verdict;
  box.innerHTML = `<div class="verdict"></div><div class="metrics"></div><ul></ul><div class="heard muted"></div>`;
  box.querySelector(".verdict").textContent = VERDICT[report.verdict] || report.verdict;
  const metrics = [
    `Duración ${m.duration_s} s`,
    `Voz ${m.speech_dbfs} dBFS`,
    `Ruido ${m.noise_dbfs} dBFS`,
    `SNR ${m.snr_db} dB`,
    `Saturación ${m.clipping_pct}%`,
  ];
  if (report.word_match !== null && report.word_match !== undefined) {
    metrics.push(`Coincidencia texto ${(report.word_match * 100).toFixed(0)}%`);
  }
  if (report.detected_language) metrics.push(`Idioma detectado: ${report.detected_language}`);
  metrics.forEach((t) => { const s = document.createElement("span"); s.textContent = t; box.querySelector(".metrics").appendChild(s); });
  (report.warnings || []).forEach((w) => { const li = document.createElement("li"); li.textContent = w; box.querySelector("ul").appendChild(li); });
  if (!(report.warnings || []).length) box.querySelector("ul").remove();
  if (report.transcription) box.querySelector(".heard").textContent = `Whisper oye: “${report.transcription}”`;
  return box;
}

/* ---------------- Voices and languages ---------------- */
async function loadVoices() {
  const res = await fetch("/api/voices");
  const voices = await res.json();
  const select = $("voice");
  const previous = select.value || store.get("voice") || (health && health.default_voice);
  select.innerHTML = "";
  voices.forEach((v) => select.add(new Option(`${v.name} (${v.duration_s}s)`, v.name)));
  if (!voices.length) select.add(new Option("— crea tu voz en 'Mi voz' —", ""));
  if (voices.some((v) => v.name === previous)) select.value = previous;
  document.dispatchEvent(new CustomEvent("fva:voices", { detail: voices }));

  const list = $("voice-list");
  list.innerHTML = "";
  if (!voices.length) list.innerHTML = '<li class="muted">Todavía no hay voces.</li>';
  voices.forEach((v) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="head"><b></b><span><button class="small-btn check">Comprobar</button>
      <button class="small-btn delete">Eliminar</button></span></div>
      <p class="muted small"></p><audio controls preload="none"></audio><div class="report-slot"></div>`;
    li.querySelector("b").textContent = `${v.name} · ${v.duration_s}s`;
    li.querySelector("p").textContent = v.transcript;
    li.querySelector("audio").src = `/api/voices/${encodeURIComponent(v.name)}/audio`;
    li.querySelector(".report-slot").appendChild(renderReport(v.quality));
    li.querySelector(".delete").addEventListener("click", async () => {
      if (!confirm(`¿Eliminar la voz '${v.name}'?`)) return;
      await fetch(`/api/voices/${encodeURIComponent(v.name)}`, { method: "DELETE" });
      loadVoices();
    });
    li.querySelector(".check").addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = "Comprobando…";
      try {
        const res = await fetch(`/api/voices/${encodeURIComponent(v.name)}/check`, { method: "POST" });
        if (!res.ok) throw new Error(await apiError(res));
        const slot = li.querySelector(".report-slot");
        slot.innerHTML = "";
        slot.appendChild(renderReport(await res.json()));
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Comprobar";
      }
    });
    list.appendChild(li);
  });
}

async function loadLanguages() {
  const langs = await (await fetch("/api/languages")).json();
  const select = $("language");
  langs.forEach((l) => select.add(new Option(l, l)));
  select.value = store.get("language") || (health && health.default_language) || "English";
}

$("voice").addEventListener("change", (e) => store.set("voice", e.target.value));
$("clone-mode").value = store.get("cloneMode") || "full";
$("clone-mode").addEventListener("change", (e) => store.set("cloneMode", e.target.value));
$("language").addEventListener("change", (e) => store.set("language", e.target.value));

/* ---------------- Generate ---------------- */
function updateCharCount() {
  const max = health ? health.max_text_chars : 5000;
  $("charcount").textContent = `${$("text").value.length} / ${max}`;
}
$("text").addEventListener("input", () => { updateCharCount(); store.set("text", $("text").value); });
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) generate(); });
$("generate").addEventListener("click", generate);

let currentUrl = null;
async function generate() {
  const text = $("text").value.trim();
  const msg = $("speak-msg");
  if (!text) return setMsg(msg, "Escribe algún texto.", "warn");
  if (!$("voice").value) return setMsg(msg, "Primero crea tu voz en la pestaña 'Mi voz'.", "warn");
  const btn = $("generate");
  btn.disabled = true;
  setMsg(msg, "Generando…");
  const t0 = performance.now();
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text, voice: $("voice").value, language: $("language").value, clone_mode: $("clone-mode").value,
      }),
    });
    if (!res.ok) throw new Error(await apiError(res));
    const blob = await res.blob();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(blob);
    $("player").src = currentUrl;
    $("monitor").src = currentUrl;
    const dl = $("download");
    dl.href = currentUrl;
    dl.download = res.headers.get("X-Output-File") || "speech.wav";
    dl.classList.remove("hidden");
    const dur = res.headers.get("X-Audio-Duration");
    const gen = res.headers.get("X-Generation-Seconds");
    const total = ((performance.now() - t0) / 1000).toFixed(1);
    $("stats").textContent = `Audio: ${dur}s · generación: ${gen}s · total: ${total}s · fragmentos: ${res.headers.get("X-Chunks")}`;
    setMsg(msg, "Listo.", "ok");
    $("player").play().catch(() => {});
  } catch (err) {
    setMsg(msg, err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- Output device (virtual microphone) ---------------- */
const player = $("player");
const monitor = $("monitor");
window.FVA.registerOutput(player); // the "Free text" player also uses the selected output
function applyFreeTextRate(rate) {
  player.playbackRate = rate;
  monitor.playbackRate = rate;
  player.preservesPitch = true;
  monitor.preservesPitch = true;
  $("playback-speed").value = String(rate);
}
$("playback-speed").addEventListener("change", (event) => setPlaybackRate(event.target.value));
document.addEventListener("fva:playback-rate", (event) => applyFreeTextRate(event.detail));
applyFreeTextRate(playbackRate());
const canSetSink = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

async function listOutputs() {
  const sinkMsg = $("sink-msg");
  if (!canSetSink) return setMsg(sinkMsg, "Este navegador no permite elegir la salida de audio. Usa Chrome o Edge.", "warn");
  try {
  // Device names are available only after microphone permission is granted.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    setMsg(sinkMsg, "Sin permiso de micrófono: los nombres de los dispositivos pueden no aparecer.", "warn");
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  const devices = all.filter((d) => d.kind === "audiooutput");
  document.dispatchEvent(new CustomEvent("fva:inputs", { detail: all.filter((d) => d.kind === "audioinput") }));
  const select = $("sink");
  const saved = store.get("sinkLabel");
  select.innerHTML = "";
  select.add(new Option("Predeterminado del sistema", ""));
  devices.forEach((d) => { if (d.deviceId !== "default") select.add(new Option(d.label || d.deviceId, d.deviceId)); });
  const match = devices.find((d) => d.label && d.label === saved);
  if (match) { select.value = match.deviceId; await applySink(); }
  if (!devices.some((d) => /cable|virtual|vb-audio|voicemeeter/i.test(d.label))) {
    setMsg(sinkMsg, "No se detecta ningún cable de audio virtual. Instala VB-CABLE (ver docs/virtual-microphone.md).", "warn");
  } else if (!match) {
    setMsg(sinkMsg, "Selecciona 'CABLE Input' para enviar la voz a Teams/Meet.");
  }
}

async function applySink() {
  const select = $("sink");
  try {
    await router.setSink(select.value);
    await Promise.all(audioOutputs.map((el) => el.setSinkId(select.value)));
    store.set("sinkLabel", select.selectedOptions[0] ? select.selectedOptions[0].text : "");
    setMsg($("sink-msg"), `Salida: ${select.selectedOptions[0].text}`, "ok");
  } catch (err) {
    setMsg($("sink-msg"), `No se pudo cambiar la salida: ${err.message}`, "err");
  }
}

$("detect-devices").addEventListener("click", listOutputs);

  // If microphone permission was granted earlier, restore the saved output without prompting.
async function restoreSinkSilently() {
  if (!canSetSink || !store.get("sinkLabel") || !navigator.permissions) return;
  try {
    const perm = await navigator.permissions.query({ name: "microphone" });
    if (perm.state === "granted") await listOutputs();
    } catch { /* browser without the Permissions API */ }
}
$("sink").addEventListener("change", applySink);
$("monitor-enabled").checked = store.get("monitor") === "1";
$("monitor-enabled").addEventListener("change", (e) => {
  store.set("monitor", e.target.checked ? "1" : "0");
  if (!e.target.checked) monitor.pause();
});

// When enabled, the monitor (default speakers) follows the main player.
player.addEventListener("play", () => {
  if (!$("monitor-enabled").checked || !$("sink").value) return;
  monitor.currentTime = player.currentTime;
  monitor.play().catch(() => {});
});
player.addEventListener("pause", () => monitor.pause());
player.addEventListener("seeked", () => { monitor.currentTime = player.currentTime; });

/* ---------------- Reference voice recording ---------------- */
let recorder = null;
let recChunks = [];
let recBlob = null;
let recTimer = null;

async function startRecording() {
  const msg = $("voice-msg");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    recChunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recBlob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
      $("rec-preview").src = URL.createObjectURL(recBlob);
      $("rec-preview").classList.remove("hidden");
      $("voice-file").value = "";
      $("voice-save").disabled = false;
    };
    recorder.start();
    const t0 = performance.now();
    recTimer = setInterval(() => { $("rec-timer").textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
    $("rec-start").disabled = true;
    $("rec-stop").disabled = false;
    setMsg(msg, "Grabando… lee el texto en inglés y pulsa Parar.");
  } catch (err) {
    setMsg(msg, `No se pudo acceder al micrófono: ${err.message}`, "err");
  }
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  clearInterval(recTimer);
  $("rec-start").disabled = false;
  $("rec-stop").disabled = true;
  setMsg($("voice-msg"), "Escucha la grabación y, si te gusta, pulsa 'Guardar voz'.");
}

$("rec-start").addEventListener("click", startRecording);
$("rec-stop").addEventListener("click", stopRecording);
$("voice-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  recBlob = null;
  $("rec-preview").src = URL.createObjectURL(file);
  $("rec-preview").classList.remove("hidden");
  $("voice-save").disabled = false;
});

$("voice-save").addEventListener("click", async () => {
  const msg = $("voice-msg");
  const file = $("voice-file").files[0];
  const audio = file || recBlob;
  if (!audio) return setMsg(msg, "Graba o sube un audio primero.", "warn");
  const form = new FormData();
  form.append("name", $("voice-name").value.trim().toLowerCase());
  form.append("transcript", $("voice-transcript").value);
  form.append("overwrite", $("voice-overwrite").checked ? "true" : "false");
  const ext = file ? "" : (recBlob.type.includes("ogg") ? ".ogg" : recBlob.type.includes("mp4") ? ".m4a" : ".webm");
  form.append("audio", audio, file ? file.name : `recording${ext}`);
  $("voice-save").disabled = true;
  $("voice-report").innerHTML = "";
  setMsg(msg, "Guardando y comprobando la grabación (la primera vez descarga Whisper, puede tardar)…");
  try {
    const res = await fetch("/api/voices", { method: "POST", body: form });
    if (!res.ok) throw new Error(await apiError(res));
    const v = await res.json();
    setMsg(msg, `Voz '${v.name}' guardada (${v.duration_s}s).`, "ok");
    $("voice-report").appendChild(renderReport(v.quality));
    store.set("voice", v.name);
    await loadVoices();
  } catch (err) {
    setMsg(msg, err.message, "err");
  } finally {
    $("voice-save").disabled = false;
  }
});

/* ---------------- Startup ---------------- */
(async function init() {
  $("text").value = store.get("text") || "";
  await pollHealth();
  await Promise.all([loadVoices(), loadLanguages(), restoreSinkSilently()]);
  await loadScript(store.get("scriptLang") || "en");
  updateCharCount();
})();

async function loadScript(lang) {
  $("voice-transcript").value = await (await fetch(`/api/reference-script?lang=${lang}`)).text();
  store.set("scriptLang", lang);
}
document.querySelectorAll("[data-script]").forEach((btn) => btn.addEventListener("click", () => loadScript(btn.dataset.script)));
