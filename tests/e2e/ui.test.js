// End-to-end presentation UI test with headless Chrome (puppeteer-core) against a fake-engine server.
// See tests/e2e/README.md. Variables: FVA_URL (default http://127.0.0.1:8799), CHROME_PATH.
const puppeteer = require("puppeteer-core");
const path = require("path");
const os = require("os");
const fs = require("fs");
const BASE = process.env.FVA_URL || "http://127.0.0.1:8799";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "OK  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const api = async (p, opts) => (await fetch(BASE + p, opts)).json();
const lookup = (texts) => api("/api/clips/lookup", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts, voice: "me" }),
});

function wav(seconds, sr = 16000) {
  const n = Math.floor(seconds * sr), buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / sr)), 44 + i * 2);
  return buf;
}

(async () => {
  // Clean state: delete previous presentations and create the test voice
  for (const p of await api("/api/presentations")) await fetch(`${BASE}/api/presentations/${p.id}`, { method: "DELETE" });
  const fd = new FormData();
  fd.append("name", "me"); fd.append("transcript", "Hello, this is my voice."); fd.append("overwrite", "true");
  fd.append("audio", new Blob([wav(5)], { type: "audio/wav" }), "me.wav");
  check((await fetch(`${BASE}/api/voices`, { method: "POST", body: fd })).status === 201, "voz de prueba creada");

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on("dialog", (d) => d.type() === "prompt" ? d.accept("Demo UI") : d.accept());
  const st = () => page.evaluate(() => {
    const s = window.FVA.present.state;
    return { playing: s.playing && { ...s.playing, id: s.pres.items[s.playing.item].id }, cursor: s.cursor,
      ids: s.pres.items.map((i) => i.id), paused: window.FVA.present.audio.paused };
  });
  const status = () => page.$eval("#pb-status", (el) => el.textContent);

  await page.goto(BASE, { waitUntil: "networkidle0" });
  check(await page.$eval("#tab-present", (el) => el.classList.contains("active")), "pestaña Presentación activa por defecto");
  check(await page.$eval("#p-empty", (el) => !el.classList.contains("hidden")), "mensaje de 'sin presentaciones' visible");
  // Disable automatic preparation to control state; it is tested later
  await page.$eval("#p-auto-prepare", (el) => { el.checked = false; el.dispatchEvent(new Event("change")); });

  /* ---------- Create and paste script ---------- */
  await page.click("#p-new");
  await page.waitForFunction(() => document.querySelectorAll("#p-edit-list .block-edit").length === 1);
  await page.click("#p-import");
  await page.type("#import-text",
    "# Slide 1 - Saludo\nGood morning everyone. [pausa] Thank you for joining.\n\n" +
    "# Slide 2 - Objetivos\nToday we look at three things.\n[click]\nFirst the start. Then the lessons.\n\n" +
    "# Slide 3 - Cierre\nThanks a lot.");
  check(await page.$eval("#import-replace", (el) => el.checked), "'reemplazar' marcado por defecto si está vacía");
  await page.click("#import-ok");
  await page.waitForFunction(() => document.querySelectorAll("#p-edit-list .block-edit").length === 3);
  check(true, "guion pegado: 3 bloques");
  await sleep(1000);
  const pid = (await api("/api/presentations"))[0].id;
  check((await api(`/api/presentations/${pid}`)).items[1].title === "Slide 2 - Objetivos", "guardado en el servidor");

  const ta = (await page.$$("#p-edit-list .block-text"))[2];
  await ta.click({ clickCount: 3 });
  await ta.type("Thanks a lot. Any questions?");
  await page.click("h1"); // blur -> change event
  await sleep(1200);
  check((await api(`/api/presentations/${pid}`)).items[2].text.endsWith("Any questions?"), "edición guardada");
  check((await page.$$eval(".block-edit .badge", (els) => els.map((e) => e.textContent))).join("|") === "○ 0/2|○ 0/3|○ 0/2",
    "marcas de estado por bloque en Editar");

  /* ---------- Present ---------- */
  await page.keyboard.press("p");
  await page.waitForSelector("#p-present-list:not(.hidden)");
  check(await page.$$eval("#p-present-list .sent", (els) => els.length) === 8, "8 frases");
  check(await page.$$eval("#p-present-list .sent.unready", (els) => els.length) === 7, "7 frases sin preparar");

  await page.select("#pb-speed", "1.5");
  check(await page.$eval("#playback-speed", (el) => el.value) === "1.5", "velocidad sincronizada entre reproductores");
  check(await page.evaluate(() => window.FVA.present.audio.playbackRate) === 1.5, "velocidad aplicada a la presentación");

  await page.keyboard.press(" ");
  await page.waitForSelector(".sent.playing", { timeout: 8000 });
  check((await status()).includes("Sonando"), "Espacio reproduce");
  await page.keyboard.press(" ");
  await sleep(150);
  check((await status()).includes("En pausa"), "Espacio pausa (justo al arrancar)");
  await page.waitForFunction(() => !document.querySelector("#pb-seek").disabled);
  await page.$eval("#pb-seek", (el) => {
    el.value = "500";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  check(await page.evaluate(() => {
    const currentAudio = window.FVA.present.audio;
    return currentAudio.duration > 0 && Math.abs(currentAudio.currentTime / currentAudio.duration - 0.5) < 0.08;
  }), "la barra permite desplazarse dentro de la frase");
  await page.keyboard.press(" ");
  await page.waitForFunction(() => /Sonando/.test(document.querySelector("#pb-status").textContent), { timeout: 3000 });
  check(true, "Espacio reanuda");
  await page.keyboard.press("Escape");

  await page.click('.sent[data-item="1"][data-sent="1"]'); // the [click] note
  await page.keyboard.press(" ");
  await page.waitForSelector('.sent.playing[data-item="1"][data-sent="2"]', { timeout: 8000 });
  check(true, "reproduce desde la frase elegida (salta la nota)");
  await page.waitForFunction(
    () => document.querySelector('.sent.cursor[data-item="2"][data-sent="0"]') && !document.querySelector(".sent.playing"),
    { timeout: 20000 });
  check(true, "fin de bloque: se para y el cursor pasa al siguiente");

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  check((await st()).cursor.item === 1 && (await st()).cursor.sent === 1, "↑ y → mueven el cursor");
  await page.keyboard.press("Home");

  /* ---------- Add a block with N during playback ---------- */
  await page.keyboard.press(" ");
  await page.waitForSelector('.sent.playing[data-item="0"]', { timeout: 8000 });
  const playingId = (await st()).playing.id;
  await page.keyboard.press("n");
  await page.waitForSelector(".block-present.editing textarea");
  check(await page.evaluate(() => document.activeElement.classList.contains("block-text")), "N abre el editor con el foco en el texto");
  // Type directly with the keyboard; letters such as 'e' must not trigger shortcuts
  await page.keyboard.type("Great question. The answer is yes.");
  await page.type(".block-present.editing .block-title", "Respuesta");
  check(await page.evaluate(() => window.FVA.present.state.mode === "present"), "escribir en el editor no cambia de modo");
  await page.click(".block-present.editing .block-text");
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  await page.waitForFunction(() => !document.querySelector(".block-present.editing"));
  let s = await st();
  check(s.ids.length === 4 && s.ids[0] === playingId, "bloque nuevo insertado debajo del actual");
  check(s.playing && s.playing.id === playingId, "la reproducción sigue en el mismo bloque");
  await page.waitForFunction(() => {
    const card = document.querySelectorAll("#p-present-list .block-present")[1];
    return card && card.querySelector(".badge").textContent === "✓ listo";
  }, { timeout: 15000 });
  check(true, "el bloque nuevo se prepara solo (aunque 'Automático' esté apagado) y marca ✓");
  const saved = await api(`/api/presentations/${pid}`);
  check(saved.items[1].title === "Respuesta", "bloque nuevo guardado en el servidor");

  /* ---------- Insert BEFORE the playing block without disrupting playback ---------- */
  await page.keyboard.press("Escape");
  await page.click('.sent[data-item="2"][data-sent="0"]');
  await page.keyboard.press(" ");
  await page.waitForSelector('.sent.playing[data-item="2"]', { timeout: 8000 });
  const pid2 = (await st()).playing.id;
  await page.click('#p-present-list .block-present[data-item="0"] .block-actions .add');
  await page.type(".block-present.editing .block-text", "Inserted before.");
  await page.click(".block-present.editing .save");
  await page.waitForFunction(() => !document.querySelector(".block-present.editing"));
  s = await st();
  check(s.playing && s.playing.id === pid2 && s.playing.item === 3, "insertar antes: el bloque que suena pasa a ser el 4 sin cortarse");
  await page.keyboard.press("Escape");

  /* ---------- Edit with ✎ and release audio for the removed sentence ---------- */
  await page.click('#p-present-list .block-present[data-item="0"] .block-actions .edit');
  await page.waitForSelector(".block-present.editing textarea");
  check(await page.$eval(".block-present.editing .block-text", (el) => el.value).then((v) => v.startsWith("Good morning")),
    "✎ abre el editor con el texto del bloque");
  await page.click(".block-present.editing .block-text", { clickCount: 3 });
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.type("Good morning everyone. Welcome!");
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  await page.waitForFunction(() => {
    const card = document.querySelector('#p-present-list .block-present[data-item="0"]');
    return card && card.querySelector(".badge").textContent === "✓ listo";
  }, { timeout: 15000 });
  const [kept, released] = await lookup(["Good morning everyone.", "Thank you for joining."]);
  check(kept && !released, "editar: la frase quitada pierde su audio y la que se mantiene lo conserva");

  /* ---------- Delete with ✕ ---------- */
  const before = (await st()).ids.length;
  await page.click('#p-present-list .block-present[data-item="1"] .block-actions .del'); // "Inserted before."
  await page.waitForFunction((n) => window.FVA.present.state.pres.items.length === n - 1, {}, before);
  check((await page.$eval("#p-toast", (el) => el.textContent)).includes("1 audio borrado"), "✕ elimina el bloque y su audio");
  check((await lookup(["Inserted before."]))[0] === null, "el .wav del bloque eliminado ya no existe");
  check((await api(`/api/presentations/${pid}`)).items.length === before - 1, "eliminado también en el servidor");

  /* ---------- Automatic preparation ---------- */
  await page.click("#p-auto-prepare");
  await page.waitForFunction(() => /^\d+\/\d+ frases listas/.test(document.querySelector("#p-progress").textContent) &&
    document.querySelectorAll("#p-present-list .sent.unready").length === 0, { timeout: 30000 });
  check(true, "'Automático' prepara todo lo que falta");

  /* ---------- Export ---------- */
  const md = await (await fetch(`${BASE}/api/presentations/${pid}/export.md`)).text();
  check(md.includes("# Respuesta\nGreat question. The answer is yes."), "exportar guion (.md)");
  const zipRes = await fetch(`${BASE}/api/presentations/${pid}/export.zip`);
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  check(zipRes.headers.get("x-missing-clips") === "0" && zipBuf.includes("presentacion_completa.wav"),
    "exportar todo (.zip) con WAV completo");
  const cdp = await page.target().createCDPSession();
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: os.tmpdir() });
  await page.click("#p-export-zip");
  await sleep(1000);

  /* ---------- Import ---------- */
  const mdPath = path.join(os.tmpdir(), "fva-e2e-guion.md");
  fs.writeFileSync(mdPath, md.replace('"title": "Demo UI"', '"title": "Copia importada"'));
  const input = await page.$("#p-file");
  await input.uploadFile(mdPath);
  await page.waitForFunction(() => /Copia importada/.test(document.querySelector("#p-select").selectedOptions[0]?.text || ""),
    { timeout: 5000 });
  check(true, "abrir archivo .md crea una presentación nueva");
  await page.waitForFunction(() => document.querySelectorAll("#p-present-list .sent.unready").length === 0 &&
    document.querySelectorAll("#p-present-list .sent").length > 0, { timeout: 10000 });
  check(true, "la copia reutiliza el audio ya generado (mismas frases)");

  await page.keyboard.press("?");
  check(await page.$eval("#help-dialog", (el) => el.open), "? abre la ayuda");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(os.tmpdir(), "present.png") });
  await page.keyboard.press("n");
  await page.waitForSelector(".block-present.editing");
  await page.type(".block-present.editing .block-text", "Typing an answer while presenting…");
  await page.screenshot({ path: path.join(os.tmpdir(), "present-editor.png") });
  await page.keyboard.press("Escape");
  check(!(await page.$(".block-present.editing")), "Esc cancela el editor");
  await page.keyboard.press("e");
  await page.screenshot({ path: path.join(os.tmpdir(), "edit.png") });

  check(errors.length === 0, "sin errores JS ni HTTP" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  console.log(failures ? `\n${failures} FALLOS` : "\nTODO OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
