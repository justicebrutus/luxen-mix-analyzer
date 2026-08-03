"use strict";

/*
 * stems.js — the "Stems" tab: Vocal / Instrumental separation.
 *
 * Runs window.luxenSeparate (hand-rolled spectral center extraction, in
 * separate.js) to split the loaded track into a vocal and an instrumental
 * buffer, then plays them together with per-stem solo / mute and live meters.
 * Own playback path; cross-stops with the Analyze transport.
 */

(function () {
  const separateBtn = document.getElementById("separateBtn");
  const playBtn = document.getElementById("stemPlayBtn");
  const stopBtn = document.getElementById("stemStopBtn");
  const statusEl = document.getElementById("stemStatus");
  const progWrap = document.getElementById("sepProgress");
  const progBar = document.getElementById("sepBar");
  if (!separateBtn) return;

  const COMPS = ["vocal", "instrumental"];
  const state = {
    ctx: null,
    srcBuffer: null,
    comp: {},
    sources: {},
    nodes: {},
    playing: false,
    separated: false,
    solo: { vocal: false, instrumental: false },
    mute: { vocal: false, instrumental: false },
  };

  function ensureCtx() {
    if (!state.ctx) state.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return state.ctx;
  }
  function setStatus(msg, color) {
    if (statusEl) { statusEl.textContent = msg; if (color) statusEl.style.color = color; }
  }
  function toBuffer(ctx, channels, length, sampleRate) {
    const buf = ctx.createBuffer(channels.length, length, sampleRate);
    for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
    return buf;
  }

  async function runSeparation() {
    if (!state.srcBuffer || typeof window.luxenSeparate !== "function") return;
    stop();
    separateBtn.disabled = true;
    if (progWrap) progWrap.style.display = "block";
    setStatus("Separating…", "var(--accent)");
    try {
      const res = await window.luxenSeparate(state.srcBuffer, (p, label) => {
        if (progBar) progBar.style.width = Math.round(p * 100) + "%";
        if (label) setStatus(label, "var(--accent)");
      });
      const ctx = ensureCtx();
      state.comp.vocal = toBuffer(ctx, res.vocal, res.length, res.sampleRate);
      state.comp.instrumental = toBuffer(ctx, res.instrumental, res.length, res.sampleRate);
      state.separated = true;
      playBtn.disabled = false;
      document.querySelectorAll(".stem-dl").forEach((b) => { b.disabled = false; });
      setStatus("Separated — solo, mute, or download a stem.", "var(--good)");
    } catch (err) {
      console.error("Separation failed:", err);
      setStatus("Separation failed — see console.", "var(--bad)");
    }
    if (progWrap) setTimeout(() => { progWrap.style.display = "none"; if (progBar) progBar.style.width = "0%"; }, 500);
    separateBtn.disabled = false;
  }

  function play() {
    if (!state.separated) return;
    if (typeof window.luxenStop === "function") window.luxenStop();
    const ctx = ensureCtx();
    ctx.resume();
    stopSources();

    const t = ctx.currentTime + 0.02;
    state.nodes = {};
    state.sources = {};
    for (const comp of COMPS) {
      const src = ctx.createBufferSource();
      src.buffer = state.comp[comp];
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(gain);
      gain.connect(analyser);
      gain.connect(ctx.destination);
      src.start(t);
      state.sources[comp] = src;
      state.nodes[comp] = { gain, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
    }
    applyGains();
    state.playing = true;
    playBtn.disabled = true;
    stopBtn.disabled = false;
    state.sources.instrumental.onended = () => { if (state.playing) stop(); };
    meterLoop();
  }

  function stopSources() {
    for (const comp of COMPS) {
      const s = state.sources[comp];
      if (s) { try { s.onended = null; s.stop(); } catch (e) { /* already stopped */ } }
    }
    state.sources = {};
  }

  function stop() {
    stopSources();
    state.playing = false;
    playBtn.disabled = !state.separated;
    stopBtn.disabled = true;
    clearMeters();
  }
  window.luxenStemsStop = stop;

  function applyGains() {
    const anySolo = state.solo.vocal || state.solo.instrumental;
    for (const comp of COMPS) {
      const audible = state.mute[comp] ? false : (anySolo ? state.solo[comp] : true);
      if (state.nodes[comp]) state.nodes[comp].gain.gain.value = audible ? 1 : 0;
      const el = document.querySelector('.stem[data-band="' + comp + '"]');
      if (el) el.classList.toggle("dim", !audible);
    }
  }

  function meterLoop() {
    if (!state.playing) return;
    for (const comp of COMPS) {
      const n = state.nodes[comp];
      if (!n) continue;
      n.analyser.getByteTimeDomainData(n.data);
      let sum = 0;
      for (let i = 0; i < n.data.length; i++) { const v = (n.data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / n.data.length);
      const fill = document.getElementById("meter-" + comp);
      if (fill) fill.style.width = Math.min(100, rms * 180).toFixed(1) + "%";
    }
    requestAnimationFrame(meterLoop);
  }
  function clearMeters() {
    for (const comp of COMPS) {
      const fill = document.getElementById("meter-" + comp);
      if (fill) fill.style.width = "0%";
    }
  }

  separateBtn.addEventListener("click", runSeparation);
  playBtn.addEventListener("click", play);
  stopBtn.addEventListener("click", stop);

  document.querySelectorAll(".stem-toggle[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const comp = btn.dataset.band;
      const act = btn.dataset.act;
      state[act][comp] = !state[act][comp];
      btn.setAttribute("aria-pressed", state[act][comp] ? "true" : "false");
      applyGains();
    });
  });

  document.querySelectorAll(".stem-dl").forEach((btn) => {
    btn.addEventListener("click", () => {
      const comp = btn.dataset.dl;
      if (state.comp[comp] && typeof window.luxenDownloadBuffer === "function") {
        window.luxenDownloadBuffer(state.comp[comp], comp);
      }
    });
  });

  window.luxenOnBuffer((buf) => {
    state.srcBuffer = buf;
    stop();
    state.separated = false;
    state.comp = {};
    separateBtn.disabled = false;
    playBtn.disabled = true;
    document.querySelectorAll(".stem-dl").forEach((b) => { b.disabled = true; });
    for (const comp of COMPS) { state.solo[comp] = false; state.mute[comp] = false; }
    document.querySelectorAll(".stem-toggle[data-act]").forEach((b) => b.setAttribute("aria-pressed", "false"));
    document.querySelectorAll(".stem").forEach((el) => el.classList.remove("dim"));
    setStatus("Press Separate Track to split it (takes a few seconds).", "var(--muted)");
  });
})();
