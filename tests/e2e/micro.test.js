// End-to-end test of the live real microphone (mixed with cloned speech) using simulated Chrome devices.
// Uses the same fake server as ui.test.js (see README.md).
const puppeteer = require("puppeteer-core");
const BASE = process.env.FVA_URL || "http://127.0.0.1:8799";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "OK  " : "FAIL"} ${msg}`); if (!cond) failures++; };

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
  const fd = new FormData();
  fd.append("name", "me"); fd.append("transcript", "Hello, this is my voice."); fd.append("overwrite", "true");
  fd.append("audio", new Blob([wav(5)], { type: "audio/wav" }), "me.wav");
  await fetch(`${BASE}/api/voices`, { method: "POST", body: fd });
  const p = await (await fetch(`${BASE}/api/presentations`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Micro", voice: "me", items: [{ title: "", text: "A fairly long sentence so that the fake voice lasts a couple of seconds." }] }),
  })).json();

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  const rs = () => page.evaluate(() => window.FVARouter.state());

  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.evaluate((id) => { localStorage.setItem("p.current", id); localStorage.setItem("p.mode", "present"); }, p.id);
  await page.reload({ waitUntil: "networkidle0" });
  check((await rs()).supported, "el navegador permite mezclar (AudioContext.setSinkId)");

  await page.click('.tab[data-tab="audio"]');
  await page.click("#detect-devices");
  await page.waitForFunction(() => document.querySelector("#mic-live-device").value !== "");
  await page.click("#mic-live-enabled");
  await page.waitForFunction(() => window.FVARouter.state().micEnabled, { timeout: 5000 });
  let s = await rs();
  check(s.micEnabled && !s.micOpen && !s.live, "micrófono activado y cerrado al empezar");

  await page.click("h1");
  await page.keyboard.press("m");
  s = await rs();
  check(s.live, "M abre el micrófono");
  check((await page.title()).startsWith("🔴"), "el título de la pestaña avisa de micro abierto");
  const gain = async () => page.evaluate(() => new Promise((r) => setTimeout(() => r(window.FVARouter.micGain.gain.value), 250)));
  check((await gain()) > 0.9, "la ganancia del micrófono sube a 1");

  // Auto-mute while cloned speech is playing
  await page.click('.tab[data-tab="present"]');
  await page.waitForSelector("#p-present-list .sent");
  check(await page.$eval("#pb-mic", (b) => !b.classList.contains("hidden") && b.classList.contains("live")),
    "botón 🎙 visible y en rojo en la barra de presentación");
  await page.click("h1");
  await page.keyboard.press(" ");
  await page.waitForFunction(() => window.FVARouter.state().ttsPlaying, { timeout: 8000 });
  s = await rs();
  check(!s.live && s.ducked, "mientras suena la voz clonada el micro se silencia solo");
  check((await gain()) < 0.1, "ganancia del micro a 0 durante la voz clonada");
  check((await page.$eval("#pb-mic", (b) => b.textContent)).includes("en pausa"), "el botón indica 'en pausa'");
  await page.waitForFunction(() => !window.FVARouter.state().ttsPlaying, { timeout: 15000 });
  await sleep(300);
  check((await rs()).live, "al terminar la voz clonada el micro vuelve a estar abierto");

  await page.keyboard.press("m");
  check(!(await rs()).live && !(await page.title()).startsWith("🔴"), "M cierra el micrófono");

  // Without auto-mute, the microphone remains open during cloned speech
  await page.click('.tab[data-tab="audio"]');
  await page.click("#mic-live-automute");
  await page.click('.tab[data-tab="present"]');
  await page.click("h1");
  await page.keyboard.press("m");
  await page.keyboard.press("Home");
  await page.keyboard.press(" ");
  await page.waitForFunction(() => window.FVARouter.state().ttsPlaying, { timeout: 8000 });
  check((await rs()).live, "sin auto-silencio el micro sigue abierto con la voz clonada");
  await page.keyboard.press("Escape");
  await page.keyboard.press("m");

  // Typing M in the editor does not open the microphone
  await page.keyboard.press("n");
  await page.waitForSelector(".block-present.editing textarea");
  await page.keyboard.type("My mic must stay closed");
  check(!(await rs()).micOpen, "teclear 'm' en el editor no abre el micrófono");
  await page.keyboard.press("Escape");

  // Real microphone test
  await page.click('.tab[data-tab="audio"]');
  await page.click("#mic-test-live");
  await page.waitForFunction(() => /^[✓⚠✗]|No se pudo/.test(document.querySelector("#mic-test-msg").textContent), { timeout: 15000 });
  check(!(await rs()).live, "tras la prueba el micro vuelve a cerrarse");
  console.log("     prueba de micro:", await page.$eval("#mic-test-msg", (e) => e.textContent));

  // After reloading, the microphone is restored but CLOSED
  await page.reload({ waitUntil: "networkidle0" });
  await page.click('.tab[data-tab="audio"]');
  await page.click("#detect-devices");
  await page.waitForFunction(() => window.FVARouter.state().micEnabled, { timeout: 5000 });
  s = await rs();
  check(s.micEnabled && !s.micOpen, "tras recargar: micro activado pero cerrado");

  check(errors.length === 0, "sin errores JS" + (errors.length ? ": " + errors.join(" | ") : ""));
  await fetch(`${BASE}/api/presentations/${p.id}`, { method: "DELETE" });
  await browser.close();
  console.log(failures ? `\n${failures} FALLOS` : "\nTODO OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
