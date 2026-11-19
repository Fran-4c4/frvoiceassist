"use strict";
/*
 * Live real microphone: FVARouter mixes it with cloned speech and sends both to the virtual cable.
 * Toggle it with M or the 🎙 buttons. It always starts closed.
 */
(function () {
  const { $, store, setMsg } = window.FVA;
  const R = window.FVARouter;
  const VIRTUAL = /cable|vb-audio|voicemeeter|virtual/i;
  const enabled = $("mic-live-enabled");
  const device = $("mic-live-device");
  const autoMute = $("mic-live-automute");
  const msg = $("mic-live-msg");
  const baseTitle = document.title;
  let meterRaf = null;

  if (!R.supported) {
    enabled.disabled = true;
    setMsg(msg, "Este navegador no permite mezclar el micrófono con la voz clonada. Usa Chrome o Edge actualizados " +
      "(o VoiceMeeter, ver docs/virtual-microphone.md).", "warn");
  }

  /* ---------- Devices ---------- */
  document.addEventListener("fva:inputs", (e) => {
    const saved = store.get("micLiveLabel");
    const real = e.detail.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications" && !VIRTUAL.test(d.label));
    device.innerHTML = "";
    real.forEach((d) => device.add(new Option(d.label || d.deviceId, d.deviceId)));
    if (!real.length) device.add(new Option("— no hay micrófonos —", ""));
    const pick = [...device.options].find((o) => o.text === saved);
    if (pick) device.value = pick.value;
    if (store.get("micLive") === "1" && R.supported && !R.state().micEnabled) {
      enabled.checked = true;
      enable();
    }
  });

  async function enable() {
    if (!device.value) {
      enabled.checked = false;
      return setMsg(msg, "Pulsa «Detectar dispositivos» (arriba) y elige tu micrófono real.", "warn");
    }
    try {
      await R.enableMic(device.value, device.selectedOptions[0].text);
      store.set("micLive", "1");
      store.set("micLiveLabel", device.selectedOptions[0].text);
      setMsg(msg, `Micrófono «${device.selectedOptions[0].text}» listo (cerrado). Ábrelo con M o 🎙.`, "ok");
      startMeter();
    } catch (err) {
      enabled.checked = false;
      setMsg(msg, "No se pudo usar el micrófono: " + err.message, "err");
    }
  }

  enabled.addEventListener("change", () => {
    if (enabled.checked) enable();
    else {
      R.disableMic();
      store.set("micLive", "0");
      setMsg(msg, "Micrófono real desactivado.");
    }
  });
  device.addEventListener("change", () => {
    store.set("micLiveLabel", device.selectedOptions[0]?.text || "");
    if (enabled.checked) enable();
  });
  autoMute.checked = store.get("micAutoMute") !== "0";
  R.setAutoMute(autoMute.checked);
  autoMute.addEventListener("change", () => {
    R.setAutoMute(autoMute.checked);
    store.set("micAutoMute", autoMute.checked ? "1" : "0");
  });

  /* ---------- Open / close ---------- */
  const toggle = (e) => {
    if (e && e.currentTarget) e.currentTarget.blur(); // prevent Space from pressing the button again
    if (!R.state().micEnabled) {
      window.FVA.showTab("audio");
      return setMsg(msg, "Activa primero «Usar mi micrófono a través del cable».", "warn");
    }
    R.toggleMic();
  };
  $("mic-live-toggle").addEventListener("click", toggle);
  $("pb-mic").addEventListener("click", toggle);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "m" && e.key !== "M") return;
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || e.target.isContentEditable) return;
    if (!R.state().micEnabled) return;
    e.preventDefault();
    R.toggleMic();
  });

  /* ---------- Indicators ---------- */
  R.onChange((s) => {
    const label = !s.micEnabled ? "🎙 Micro desactivado"
      : s.live ? "🔴 MICRO ABIERTO"
      : s.ducked ? "🎙 Micro en pausa (suena la voz)"
      : "🎙 Micro cerrado";
    [$("mic-live-toggle"), $("pb-mic")].forEach((b) => {
      b.textContent = b.id === "mic-live-toggle" ? `${label} (M)` : label;
      b.classList.toggle("live", s.live);
      b.classList.toggle("ducked", s.ducked);
    });
    $("mic-live-toggle").disabled = !s.micEnabled;
    $("pb-mic").classList.toggle("hidden", !s.micEnabled);
    document.title = s.live ? "🔴 " + baseTitle : baseTitle; // visible even when the tab is not in front
    if (!s.micEnabled) stopMeter();
  });

  function startMeter() {
    stopMeter();
    const bar = $("mic-live-bar");
    const tick = () => {
      const db = R.micLevel();
      bar.style.width = Math.max(0, Math.min(100, ((db + 70) / 70) * 100)) + "%";
      bar.className = R.state().live ? "live" : "";
      meterRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = null;
    $("mic-live-bar").style.width = "0";
  }
})();
