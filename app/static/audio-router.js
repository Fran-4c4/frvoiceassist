"use strict";
/*
 * Audio router: mixes the cloned voice and optionally the real microphone into one AudioContext whose output
 * is the selected device (for example, CABLE Input). Teams/Meet receives both through CABLE Output.
 *
 *   <audio> cloned voice ─► ttsGain ─┐
 *                                   ├─► AudioContext (setSinkId) ─► CABLE Input
 *   real microphone ─────► micGain ─┘
 *
 * The microphone always starts closed. With auto-mute enabled, it closes while cloned speech is playing.
 * Requires AudioContext.setSinkId (Chrome/Edge 110+); without it, each <audio> uses setSinkId directly and
 * microphone mixing is unavailable.
 */
(function () {
  const supported = typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
  const listeners = [];
  const playing = new Set(); // cloned-voice elements currently playing
  const R = {
    supported,
    ctx: null,
    ttsGain: null,
    micGain: null,
    micAnalyser: null,
    micStream: null,
    micSource: null,
    micDeviceLabel: "",
    micOpen: false, // opened by the user (M)
    autoMute: true,
    forced: false, // temporarily opened by the microphone test
    sinkId: "",
  };

  function ensureCtx() {
    if (!supported) return null;
    if (!R.ctx) {
      R.ctx = new AudioContext({ latencyHint: "interactive" });
      R.ttsGain = R.ctx.createGain();
      R.ttsGain.connect(R.ctx.destination);
      R.micGain = R.ctx.createGain();
      R.micGain.gain.value = 0;
      R.micGain.connect(R.ctx.destination);
    }
    return R.ctx;
  }
  ensureCtx();

    // Browsers allow audio to start only after a user interaction
  const resume = () => { if (R.ctx && R.ctx.state === "suspended") R.ctx.resume().catch(() => {}); };
  ["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, resume, true));

  function state() {
    const live = R.micStream && (R.forced || (R.micOpen && !(R.autoMute && playing.size > 0)));
    return {
      supported,
      micEnabled: !!R.micStream,
      micOpen: R.micOpen,
      live: !!live, // the microphone is currently reaching the call
      ducked: R.micOpen && !live, // open but muted because cloned speech is playing
      ttsPlaying: playing.size > 0,
    };
  }

  function update() {
    if (R.micGain) {
      const target = state().live ? 1 : 0;
    R.micGain.gain.setTargetAtTime(target, R.ctx.currentTime, 0.03); // short ramp to avoid clicks
    }
    const s = state();
    listeners.forEach((fn) => fn(s));
  }

  R.state = state;
  R.onChange = (fn) => { listeners.push(fn); fn(state()); };

  /** Route cloned-voice <audio> through the mix. Return false when it must use its own setSinkId. */
  R.attach = (el) => {
    if (!ensureCtx()) return false;
    R.ctx.createMediaElementSource(el).connect(R.ttsGain);
    el.addEventListener("playing", () => { playing.add(el); update(); });
    ["pause", "ended", "emptied", "error"].forEach((ev) => el.addEventListener(ev, () => { playing.delete(el); update(); }));
    return true;
  };

  R.setSink = async (deviceId) => {
    R.sinkId = deviceId || "";
    if (supported) await R.ctx.setSinkId(R.sinkId);
  };

  R.enableMic = async (deviceId, label = "") => {
    if (!ensureCtx()) throw new Error("Este navegador no permite mezclar el micrófono (usa Chrome o Edge actualizados).");
    R.disableMic();
    R.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
    // Process the real voice as in a normal call
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      },
    });
    R.micDeviceLabel = label;
    R.micSource = R.ctx.createMediaStreamSource(R.micStream);
    R.micAnalyser = R.ctx.createAnalyser();
    R.micAnalyser.fftSize = 1024;
    R.micSource.connect(R.micAnalyser);
    R.micSource.connect(R.micGain);
    R.micOpen = false; // always starts closed
    update();
  };

  R.disableMic = () => {
    if (R.micSource) R.micSource.disconnect();
    if (R.micStream) R.micStream.getTracks().forEach((t) => t.stop());
    R.micStream = R.micSource = R.micAnalyser = null;
    R.micOpen = false;
    update();
  };

  R.setMicOpen = (open) => { R.micOpen = !!open && !!R.micStream; update(); };
  R.toggleMic = () => R.setMicOpen(!R.micOpen);
  R.setAutoMute = (on) => { R.autoMute = !!on; update(); };
  R.forceMic = (on) => { R.forced = !!on && !!R.micStream; update(); };

  /** Real microphone level in dBFS (before the switch), used by the meter. */
  R.micLevel = () => {
    if (!R.micAnalyser) return -120;
    const data = new Float32Array(R.micAnalyser.fftSize);
    R.micAnalyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return 20 * Math.log10(Math.sqrt(sum / data.length) + 1e-9);
  };

  window.FVARouter = R;
})();
