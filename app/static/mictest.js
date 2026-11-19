"use strict";
/*
 * Virtual microphone test ("Audio output" tab).
 * Plays a sentence through the selected output (for example, CABLE Input) while recording and measuring the
 * microphone used by Teams/Meet (for example, CABLE Output). A level clearly above the noise floor confirms
 * that the browser -> virtual cable -> call chain works.
 */
(function () {
  const { $, store, setMsg, apiError } = window.FVA;
  const TEST_TEXT = "Hello, this is a microphone test. If you can hear me clearly, everything is working.";
  const OK_PEAK_DB = -45; // minimum level that must arrive
  const OK_MARGIN_DB = 15; // dB above the noise floor
  let running = false;

  /* ---------- Microphone list ---------- */
  document.addEventListener("fva:inputs", (e) => {
    const sel = $("mic-test-input");
    const saved = store.get("micTestLabel");
    sel.innerHTML = "";
    e.detail.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications")
      .forEach((d) => sel.add(new Option(d.label || d.deviceId, d.deviceId)));
    if (!sel.options.length) sel.add(new Option("— no hay micrófonos —", ""));
    const opts = [...sel.options];
    const pick = opts.find((o) => o.text === saved) || opts.find((o) => /cable output|vb-audio|voicemeeter out/i.test(o.text));
    if (pick) sel.value = pick.value;
  });
  $("mic-test-input").addEventListener("change", (e) => store.set("micTestLabel", e.target.selectedOptions[0]?.text || ""));

  /* ---------- Test sound ---------- */
  async function testSoundUrl(msg) {
    try {
      const health = await (await fetch("/api/health")).json();
      const voices = await (await fetch("/api/voices")).json();
      const voice = voices.find((v) => v.name === health.default_voice) || voices[0];
      if (health.status === "ready" && voice) {
        setMsg(msg, `Preparando la frase de prueba con la voz «${voice.name}» (la primera vez tarda unos segundos)…`);
        const res = await fetch("/api/clips", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: TEST_TEXT, voice: voice.name }),
        });
        if (res.ok) return (await res.json()).url;
        setMsg(msg, "No se pudo generar la frase (" + (await apiError(res)) + "); se usará un tono.", "warn");
      }
    } catch { /* fall back to the tone */ }
    return URL.createObjectURL(toneWav());
  }

    // 2.5 seconds of 440 Hz beeps in case the model is not ready
  function toneWav(seconds = 2.5, sr = 24000) {
    const n = Math.floor(seconds * sr);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data");
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const on = Math.floor((i / sr) * 4) % 2 === 0;
      v.setInt16(44 + i * 2, on ? Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / sr)) : 0, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  /* ---------- Measurement ---------- */
  function levelDb(analyser, data) {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return 20 * Math.log10(Math.sqrt(sum / data.length) + 1e-9);
  }

  function showMeter(db) {
    const pct = Math.max(0, Math.min(100, ((db + 70) / 70) * 100)); // -70 dB .. 0 dB
    const bar = $("mic-meter-bar");
    bar.style.width = pct + "%";
    bar.className = db > OK_PEAK_DB ? "ok" : "";
  }

    // mode "voice": play cloned speech; mode "mic": open the real microphone for 4 s through FVARouter
  async function runTest(mode = "voice") {
    if (running) return;
    const R = window.FVARouter;
    const msg = $("mic-test-msg");
    const sinkSel = $("sink");
    const inputId = $("mic-test-input").value;
    $("mic-test-result").classList.add("hidden");
    if (!inputId) return setMsg(msg, "Pulsa «Detectar dispositivos» y elige el micrófono (CABLE Output).", "warn");
    if (mode === "mic" && !R.state().micEnabled) {
      return setMsg(msg, "Activa antes «Usar mi micrófono a través del cable» (tarjeta de arriba).", "warn");
    }
    if (!sinkSel.value) {
      setMsg(msg, "Aviso: la salida es la predeterminada del sistema, no un cable virtual. La prueba solo tiene sentido " +
        "si eliges arriba «CABLE Input». Continúo igualmente…", "warn");
    }
    running = true;
    $("mic-test-run").disabled = true;
    // Create it in the same click; Chrome may leave it suspended if creation waits for permission
    const ctx = new AudioContext();
    let stream, raf;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: inputId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      await ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const chunks = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const recorded = new Promise((resolve) => { rec.onstop = resolve; });

      let player = null, monitor = null;
      if (mode === "voice") {
        const url = await testSoundUrl(msg);
        player = new Audio(url);
    // Follow the presentation path: use the mix when available, otherwise call setSinkId directly
        if (!R.attach(player) && sinkSel.value) await player.setSinkId(sinkSel.value);
        monitor = window.FVA.monitorWanted() ? new Audio(url) : null;
      }

    // Noise floor (0.6 s without the test sound)
      rec.start();
      let base = -120;
      const t0 = performance.now();
      while (performance.now() - t0 < 600) {
        base = Math.max(base, levelDb(analyser, data));
        showMeter(levelDb(analyser, data));
        await new Promise((r) => setTimeout(r, 50));
      }
      setMsg(msg, mode === "voice"
        ? "Reproduciendo la frase de prueba y escuchando el micrófono…"
        : "🔴 Micrófono abierto 4 segundos: habla ahora (en inglés, por ejemplo «Hello, can you hear me?»)…");
      let peak = -120;
    let loud = 0; // time clearly above the noise floor
      const tick = () => {
        const db = levelDb(analyser, data);
        showMeter(db);
        peak = Math.max(peak, db);
        if (db > OK_PEAK_DB && db > base + OK_MARGIN_DB) loud++;
        raf = requestAnimationFrame(tick);
      };
      tick();
      if (mode === "voice") {
        const ended = new Promise((resolve) => { player.onended = resolve; player.onerror = resolve; });
        await player.play();
        if (monitor) monitor.play().catch(() => {});
        await Promise.race([ended, new Promise((r) => setTimeout(r, 20000))]);
      } else {
        R.forceMic(true);
        await new Promise((r) => setTimeout(r, 4000));
        R.forceMic(false);
      }
      await new Promise((r) => setTimeout(r, 400));
      cancelAnimationFrame(raf);
      rec.stop();
      await recorded;
      showMeter(-120);

      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      $("mic-test-playback").src = URL.createObjectURL(blob);
      $("mic-test-result").classList.remove("hidden");
      const inputName = $("mic-test-input").selectedOptions[0].text;
      const detail = `pico ${peak.toFixed(0)} dB · ruido de base ${base.toFixed(0)} dB`;
      if (loud > 10 && peak > OK_PEAK_DB && peak > base + OK_MARGIN_DB) {
        setMsg(msg, mode === "voice"
          ? `✓ Funciona: la voz clonada llega a «${inputName}» (${detail}). En Teams/Meet elige ese micrófono.`
          : `✓ Funciona: tu micrófono real llega a «${inputName}» (${detail}). Escucha la grabación para oír cómo suenas.`,
        "ok");
      } else if (mode === "mic" && peak <= OK_PEAK_DB) {
        setMsg(msg, `✗ No llega tu voz a «${inputName}» (${detail}). ¿Hablaste durante los 4 s? Comprueba que el ` +
          "micrófono real elegido arriba es el correcto (mira que su barra se mueva al hablar).", "err");
      } else if (peak > OK_PEAK_DB) {
        setMsg(msg, `⚠ Llega sonido a «${inputName}», pero no se distingue bien del ruido (${detail}). ` +
          "¿Es ese el micrófono del cable virtual? Escucha la grabación.", "warn");
      } else {
        setMsg(msg, `✗ No llega audio a «${inputName}» (${detail}). Comprueba que la salida de arriba es «CABLE Input» ` +
          "y que este micrófono es «CABLE Output». Mira también que «CABLE Output» no esté silenciado en Windows.", "err");
      }
    } catch (err) {
      setMsg(msg, "No se pudo hacer la prueba: " + err.message, "err");
    } finally {
      R.forceMic(false);
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      running = false;
      $("mic-test-run").disabled = false;
    }
  }

  $("mic-test-run").addEventListener("click", () => runTest("voice"));
  $("mic-test-live").addEventListener("click", () => runTest("mic"));
  window.FVA.micTest = { run: runTest }; // exposed for e2e tests
})();
