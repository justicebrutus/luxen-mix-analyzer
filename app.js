"use strict";

const $ = (id) => document.getElementById(id);

let audioCtx = null;
let buffer = null;
let source = null;
let isPlaying = false;
let startedAt = 0;
let pausedAt = 0;

let lowFilter, midFilter, highFilter, gainNode, analyser;
let spectrumData;

let pitchSemitones = 0;
let pitchMode = "speed";
let originalBuffer = null;
let currentTuningHz = 440;
let currentFileName = "track";
let detectFrameCounter = 0;
const freqHistory = [];

function ensureContext() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  lowFilter = audioCtx.createBiquadFilter();
  lowFilter.type = "lowshelf";
  lowFilter.frequency.value = 200;
  lowFilter.gain.value = 0;

  midFilter = audioCtx.createBiquadFilter();
  midFilter.type = "peaking";
  midFilter.frequency.value = 1500;
  midFilter.Q.value = 0.9;
  midFilter.gain.value = 0;

  highFilter = audioCtx.createBiquadFilter();
  highFilter.type = "highshelf";
  highFilter.frequency.value = 8000;
  highFilter.gain.value = 0;

  gainNode = audioCtx.createGain();
  gainNode.gain.value = 0.9;

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  spectrumData = new Uint8Array(analyser.frequencyBinCount);

  lowFilter.connect(midFilter);
  midFilter.connect(highFilter);
  highFilter.connect(gainNode);
  gainNode.connect(analyser);
  analyser.connect(audioCtx.destination);
}

const uploader = $("uploader");
const fileInput = $("fileInput");
const fileLabel = $("fileLabel");
const playBtn = $("playBtn");
const pauseBtn = $("pauseBtn");

uploader.addEventListener("dragover", e => { e.preventDefault(); });
uploader.addEventListener("dragenter", e => { e.preventDefault(); });
uploader.addEventListener("drop", e => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", e => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});

async function loadFile(file) {
  ensureContext();
  fileLabel.textContent = "Decoding...";
  const arr = await file.arrayBuffer();
  let decoded;
  try {
    decoded = await audioCtx.decodeAudioData(arr);
  } catch (err) {
    fileLabel.textContent = "Could not decode this file.";
    return;
  }
  loadDecoded(decoded, file.name);
}

// Shared load path for both uploaded files and the generated demo track.
function loadDecoded(decoded, name) {
  buffer = decoded;
  originalBuffer = decoded;
  uploader.classList.add("has-file");
  currentFileName = name.replace(/\.[^.]+$/, "") || "track";
  fileLabel.textContent = name + "  -  " + formatTime(buffer.duration) + "  -  " + buffer.sampleRate + " Hz  -  " + buffer.numberOfChannels + " ch";
  playBtn.disabled = false;
  const dl = $("downloadBtn"); if (dl) dl.disabled = false;
  pausedAt = 0;
  initTransport();
  analyzeBuffer(buffer);
  luxenNotifyBuffer(buffer, name);
}

// ---- Demo track: a short musical mix synthesised in the browser ----
// Deliberately built so the tools have something to show: a CENTERED lead in
// the vocal band (separates out), stereo-panned pads (stay instrumental), a
// low center bass and drums. No bundled audio assets.
function generateDemoBuffer(ctx) {
  const sr = ctx.sampleRate;
  const dur = 8;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  const chords = [
    { pad: [220.00, 261.63, 329.63], bass: 110.00 }, // Am
    { pad: [220.00, 261.63, 349.23], bass: 87.31 },  // F
    { pad: [261.63, 329.63, 392.00], bass: 130.81 }, // C
    { pad: [246.94, 293.66, 392.00], bass: 98.00 },  // G
  ];
  const barLen = dur / chords.length;          // 2s per chord
  const lead = [659.25, 587.33, 523.25, 587.33, 659.25, 783.99, 659.25, 587.33]; // melody, one note/bar-half
  const noteLen = dur / lead.length;           // 1s per lead note

  const env = (t, a, d) => Math.min(1, t / a) * Math.exp(-Math.max(0, t - a) / d);

  // Soft harmonic tone (warm, not a raw sine) for the lead.
  const warmTone = (phase) =>
    Math.sin(phase) + 0.5 * Math.sin(2 * phase) * 0.6 + 0.28 * Math.sin(3 * phase) * 0.4;

  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const ci = Math.min(chords.length - 1, Math.floor(t / barLen));
    const chord = chords[ci];
    const tb = t - ci * barLen;

    // Pad: triad, decorrelated across L/R (slight detune) → sides → instrumental.
    // Gentle tremolo gives it a little life instead of a static drone.
    let padL = 0, padR = 0;
    for (let v = 0; v < chord.pad.length; v++) {
      const f = chord.pad[v];
      padL += Math.sin(2 * Math.PI * f * 1.003 * t);
      padR += Math.sin(2 * Math.PI * f * 0.997 * t + 0.6);
    }
    const trem = 0.9 + 0.1 * Math.sin(2 * Math.PI * 0.8 * t);
    const padEnv = 0.10 * env(tb, 0.25, 3.2) * trem;
    padL *= padEnv; padR *= padEnv;

    // Bass: center, low (below the vocal gate) → instrumental. Add a touch of
    // 2nd harmonic for warmth rather than a pure sine.
    const bph = 2 * Math.PI * chord.bass * t;
    const bass = (Math.sin(bph) + 0.25 * Math.sin(2 * bph)) * 0.20 * env(tb, 0.03, 2.6);

    // Lead "vocal": centered, vocal band, warm tone, legato + vibrato → VOCAL.
    const li = Math.min(lead.length - 1, Math.floor(t / noteLen));
    const tn = t - li * noteLen;
    const vib = 1 + 0.005 * Math.sin(2 * Math.PI * 5.2 * t);
    const leadSig = 0.16 * warmTone(2 * Math.PI * lead[li] * vib * t) * env(tn, 0.06, 0.9);

    // Drums: soft kick on the beat, quiet muted hat on the offbeat.
    const beat = t % 0.5;
    const kick = 0.42 * Math.sin(2 * Math.PI * (100 * Math.exp(-beat * 28) + 44)) * Math.exp(-beat * 16);
    const hatPhase = (t + 0.25) % 0.5;
    const hat = (Math.random() * 2 - 1) * Math.exp(-hatPhase * 90) * 0.035;

    const center = bass + leadSig + kick;
    L[i] = center + padL + hat;
    R[i] = center + padR - hat;
  }

  // Warmth: one-pole low-pass to tame harshness, then soft-clip glue.
  let yL = 0, yR = 0;
  const a = 0.42;
  for (let i = 0; i < len; i++) {
    yL += (L[i] - yL) * a; yR += (R[i] - yR) * a;
    L[i] = Math.tanh(yL * 1.4);
    R[i] = Math.tanh(yR * 1.4);
  }

  // Normalise to a safe peak.
  let peak = 0;
  for (let i = 0; i < len; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  if (peak > 0) { const g = 0.82 / peak; for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; } }
  return buf;
}

const demoBtn = $("demoBtn");
if (demoBtn) {
  demoBtn.addEventListener("click", async () => {
    ensureContext();
    audioCtx.resume();
    // Preferred: the real track embedded as a data URI (demo-audio.js) so it
    // plays on any open method — file://, GitHub download, or a deployed URL —
    // with no network fetch. Falls back to a sibling demo.mp3, then to the
    // synthesised mix, so the button always does something.
    try {
      if (window.LUXEN_DEMO_DATAURI) {
        const ab = await (await fetch(window.LUXEN_DEMO_DATAURI)).arrayBuffer();
        const decoded = await audioCtx.decodeAudioData(ab);
        loadDecoded(decoded, "Luxen demo track");
        return;
      }
    } catch (e) { /* embedded decode failed — fall through */ }
    try {
      const res = await fetch("demo.mp3");
      if (res.ok) {
        const ab = await res.arrayBuffer();
        const decoded = await audioCtx.decodeAudioData(ab);
        loadDecoded(decoded, "Luxen demo track");
        return;
      }
    } catch (e) { /* no bundled demo — fall through to synth */ }
    loadDecoded(generateDemoBuffer(audioCtx), "Luxen demo track");
  });
}

// Fan a newly-loaded buffer out to any subscribed tab modules (Field, Stems).
function luxenNotifyBuffer(buf, name) {
  (window.__luxenBufferSubs || []).forEach((fn) => { try { fn(buf, name); } catch (e) { console.error(e); } });
  if (typeof window.onLuxenBufferLoaded === "function") window.onLuxenBufferLoaded(buf, name);
}
window.luxenOnBuffer = (fn) => { (window.__luxenBufferSubs = window.__luxenBufferSubs || []).push(fn); };

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return m + ":" + sec;
}

// Start (or restart) playback from a given offset in seconds. Any existing
// source is stopped silently first, so this doubles as the seek primitive.
function startSource(offset) {
  if (!buffer) return;
  ensureContext();
  audioCtx.resume();
  if (typeof window.luxenStemsStop === "function") window.luxenStemsStop(); // don't double up with the Stems tab
  if (source) { try { source.onended = null; source.stop(); } catch (e) { /* already stopped */ } }
  offset = Math.max(0, Math.min(buffer.duration - 0.001, offset));
  source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = (pitchMode === "speed") ? Math.pow(2, pitchSemitones / 12) : 1.0;
  source.connect(lowFilter);
  source.start(0, offset);
  startedAt = audioCtx.currentTime - offset;
  pausedAt = offset;
  isPlaying = true;
  playBtn.disabled = true;
  pauseBtn.disabled = false;
  drawSpectrum();
  source.onended = () => {
    isPlaying = false;
    playBtn.disabled = false;
    pauseBtn.disabled = true;
    pausedAt = 0;
    if (seekBar) seekBar.value = 0;
    updateTimeDisplay(0);
  };
}

playBtn.addEventListener("click", () => {
  if (!buffer || isPlaying) return;
  startSource(pausedAt);
});

pauseBtn.addEventListener("click", () => {
  if (!isPlaying) return;
  source.onended = null;
  source.stop();
  pausedAt = audioCtx.currentTime - startedAt;
  isPlaying = false;
  playBtn.disabled = false;
  pauseBtn.disabled = true;
});

function bindEQ(sliderId, valueId, filterRef) {
  const slider = $(sliderId);
  const valEl = $(valueId);
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    valEl.textContent = (v >= 0 ? "+" : "") + v.toFixed(1) + " dB";
    if (filterRef()) filterRef().gain.value = v;
  });
}
bindEQ("eqLow",  "eqLowVal",  () => lowFilter);
bindEQ("eqMid",  "eqMidVal",  () => midFilter);
bindEQ("eqHigh", "eqHighVal", () => highFilter);

document.querySelectorAll(".preset").forEach(btn => {
  if (btn.dataset.low === undefined) return;
  btn.addEventListener("click", () => {
    const lo = parseFloat(btn.dataset.low);
    const md = parseFloat(btn.dataset.mid);
    const hi = parseFloat(btn.dataset.high);
    $("eqLow").value = lo;  $("eqLowVal").textContent = fmt(lo);
    $("eqMid").value = md;  $("eqMidVal").textContent = fmt(md);
    $("eqHigh").value = hi; $("eqHighVal").textContent = fmt(hi);
    ensureContext();
    lowFilter.gain.value = lo;
    midFilter.gain.value = md;
    highFilter.gain.value = hi;
  });
});
function fmt(v) { return (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"; }

async function analyzeBuffer(buf) {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  let peak = 0;
  let sumSquares = 0;
  const N = ch0.length;
  for (let i = 0; i < N; i++) {
    const sample = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i];
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / N);
  const peakDb = 20 * Math.log10(Math.max(peak, 1e-10));
  const rmsDb  = 20 * Math.log10(Math.max(rms, 1e-10));
  const crest  = peakDb - rmsDb;

  const balance = computeFrequencyBalanceFFT(buf);

  renderScorecard({ peakDb, crest, balance, lufs: null, lufsLoading: true });

  try {
    const lufs = await computeKWeightedLUFS(buf);
    renderScorecard({ peakDb, crest, balance, lufs, lufsLoading: false });
  } catch (err) {
    console.error("LUFS computation failed:", err);
    renderScorecard({ peakDb, crest, balance, lufs: rmsDb - 0.7, lufsLoading: false, lufsApprox: true });
  }
}

function fft(real, imag) {
  const N = real.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const halfLen = len >> 1;
    const ang = -2 * Math.PI / len;
    const wStepR = Math.cos(ang);
    const wStepI = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let wR = 1, wI = 0;
      for (let j = 0; j < halfLen; j++) {
        const tR = wR * real[i + j + halfLen] - wI * imag[i + j + halfLen];
        const tI = wR * imag[i + j + halfLen] + wI * real[i + j + halfLen];
        real[i + j + halfLen] = real[i + j] - tR;
        imag[i + j + halfLen] = imag[i + j] - tI;
        real[i + j] += tR;
        imag[i + j] += tI;
        const newWR = wR * wStepR - wI * wStepI;
        wI = wR * wStepI + wI * wStepR;
        wR = newWR;
      }
    }
  }
}

function computeFrequencyBalanceFFT(buf) {
  const SIZE = 4096;
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const sampleRate = buf.sampleRate;

  const hann = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (SIZE - 1));

  const real = new Float32Array(SIZE);
  const imag = new Float32Array(SIZE);

  const LOW_MAX = 250;
  const MID_MAX = 4000;

  let lowSum = 0, midSum = 0, highSum = 0;
  for (let start = 0; start + SIZE <= ch0.length; start += SIZE) {
    for (let i = 0; i < SIZE; i++) {
      const sample = ch1 ? 0.5 * (ch0[start + i] + ch1[start + i]) : ch0[start + i];
      real[i] = sample * hann[i];
      imag[i] = 0;
    }
    fft(real, imag);
    for (let bin = 1; bin < SIZE / 2; bin++) {
      const hz = bin * sampleRate / SIZE;
      const power = real[bin] * real[bin] + imag[bin] * imag[bin];
      if (hz < LOW_MAX) lowSum += power;
      else if (hz < MID_MAX) midSum += power;
      else highSum += power;
    }
  }

  const total = lowSum + midSum + highSum || 1;
  return { low: lowSum / total, mid: midSum / total, high: highSum / total };
}

async function computeKWeightedLUFS(buf) {
  const targetRate = 48000;
  const offlineCtx = new OfflineAudioContext(
    buf.numberOfChannels,
    Math.ceil(buf.duration * targetRate) + 1,
    targetRate
  );
  const src = offlineCtx.createBufferSource();
  src.buffer = buf;
  src.connect(offlineCtx.destination);
  src.start();
  const rendered = await offlineCtx.startRendering();

  const K1 = { b0:  1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
               a1: -1.69065929318241, a2:  0.73248077421585 };
  const K2 = { b0:  1.0,              b1: -2.0,              b2: 1.0,
               a1: -1.99004745483398, a2:  0.99007225036621 };

  const numCh = rendered.numberOfChannels;
  const N = rendered.length;

  const weighted = [];
  for (let ch = 0; ch < numCh; ch++) {
    const input = rendered.getChannelData(ch);
    const tmp = new Float32Array(N);
    const out = new Float32Array(N);
    applyBiquadInPlace(input, tmp, K1);
    applyBiquadInPlace(tmp,   out, K2);
    weighted.push(out);
  }

  const blockSize = Math.round(0.4 * targetRate);
  const hop = Math.round(blockSize * 0.25);
  const blocks = [];
  for (let start = 0; start + blockSize <= N; start += hop) {
    let blockSumSq = 0;
    for (let ch = 0; ch < numCh; ch++) {
      const data = weighted[ch];
      for (let i = 0; i < blockSize; i++) {
        const s = data[start + i];
        blockSumSq += s * s;
      }
    }
    const ms = blockSumSq / blockSize;
    const loudness = -0.691 + 10 * Math.log10(Math.max(ms, 1e-30));
    blocks.push({ ms, loudness });
  }
  if (blocks.length === 0) return -Infinity;

  let stage1 = blocks.filter(b => b.loudness > -70);
  if (stage1.length === 0) return -70;

  const meanMS1 = stage1.reduce((s, b) => s + b.ms, 0) / stage1.length;
  const meanL1 = -0.691 + 10 * Math.log10(meanMS1);
  const relGate = meanL1 - 10;
  let stage2 = stage1.filter(b => b.loudness > relGate);
  if (stage2.length === 0) stage2 = stage1;

  const meanMS2 = stage2.reduce((s, b) => s + b.ms, 0) / stage2.length;
  return -0.691 + 10 * Math.log10(meanMS2);
}

function applyBiquadInPlace(input, output, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    output[i] = y;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
  }
}

function renderScorecard(opts) {
  const card = $("scorecard");
  const peakDb = opts.peakDb;
  const crest = opts.crest;
  const balance = opts.balance;
  const lufs = opts.lufs;
  const lufsLoading = opts.lufsLoading;
  const lufsApprox = opts.lufsApprox;

  function metric(label, hint, value, badge) {
    return '<div class="metric">' +
      '<div class="metric-label">' + label + '<span class="hint">' + hint + '</span></div>' +
      '<div class="metric-value"><div class="num">' + value + '</div><div class="badge ' + badge + '"></div></div>' +
      '</div>';
  }

  let lufsLine;
  if (lufsLoading) {
    lufsLine = metric("Integrated Loudness",
      "K-weighted, gated per ITU-R BS.1770-4. Target: -14 LUFS Spotify / -16 Apple Music",
      "Computing...", "");
  } else {
    const lufsBadge = lufs > -8 ? "bad" : (lufs < -20 ? "warn" : "good");
    const display = lufsApprox ? ("~" + lufs.toFixed(1) + " LUFS (approx)") : (lufs.toFixed(1) + " LUFS");
    lufsLine = metric("Integrated Loudness",
      "K-weighted, gated per ITU-R BS.1770-4. Target: -14 LUFS Spotify / -16 Apple Music",
      display, lufsBadge);
  }

  const peakBadge = peakDb >= -0.1 ? "bad" : (peakDb >= -1.0 ? "warn" : "good");
  const crestBadge = crest < 6 ? "bad" : (crest < 9 ? "warn" : "good");
  const pct = (n) => Math.round(n * 100) + "%";
  const balanceStr = "L " + pct(balance.low) + "  -  M " + pct(balance.mid) + "  -  H " + pct(balance.high);
  const balanceBadge = (Math.abs(balance.low - 0.30) > 0.25 || Math.abs(balance.high - 0.25) > 0.25) ? "warn" : "good";

  card.innerHTML = lufsLine +
    metric("True Peak", "Should stay below -1 dB to avoid inter-sample clipping on streaming services",
           peakDb.toFixed(2) + " dBFS", peakBadge) +
    metric("Dynamic Range (Crest Factor)", "How much louder peaks are vs the RMS average. 9 dB or more = healthy mix",
           crest.toFixed(1) + " dB", crestBadge) +
    metric("Frequency Balance", "Lows < 250 Hz  -  Mids 250 Hz to 4 kHz  -  Highs > 4 kHz (FFT-based)",
           balanceStr, balanceBadge);
}

const canvas = $("spectrumCanvas");
const cctx = canvas.getContext("2d");
function resizeCanvas() {
  canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
  canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function drawSpectrum() {
  if (!isPlaying || !analyser) return;
  analyser.getByteFrequencyData(spectrumData);
  cctx.clearRect(0, 0, canvas.width, canvas.height);

  const bars = 64;
  const step = Math.floor(spectrumData.length / bars);
  const barW = canvas.width / bars;
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += spectrumData[i * step + j];
    const v = sum / step / 255;
    const h = v * canvas.height;
    const hue = 200 + (i / bars) * 60;
    cctx.fillStyle = "hsl(" + hue + ", 80%, " + (40 + v * 30) + "%)";
    cctx.fillRect(i * barW + 1, canvas.height - h, barW - 2, h);
  }

  detectFrameCounter++;
  if (detectFrameCounter % 4 === 0) detectDominantFrequency();

  // Advance the scrub bar with playback (unless the user is dragging it).
  if (!isScrubbing && seekBar && duration > 0) {
    const pos = audioCtx.currentTime - startedAt;
    seekBar.value = Math.max(0, Math.min(1000, (pos / duration) * 1000));
    updateTimeDisplay(pos);
  }

  requestAnimationFrame(drawSpectrum);
}

// ---- Transport: scrub to any point + restart ----
const seekBar = $("seekBar");
const restartBtn = $("restartBtn");
const timeCur = $("timeCur");
const timeTotal = $("timeTotal");
let duration = 0;
let isScrubbing = false;
let wasPlayingBeforeSeek = false;

// A/B compare: two editable versions (EQ + tuning/pitch) you toggle between.
const AB_DEFAULT = () => ({ lo: 0, mid: 0, hi: 0, semi: 0, mode: "speed" });
const abSlots = { A: AB_DEFAULT(), B: AB_DEFAULT() };
let abActive = "A";
const abBtnA = $("abA");
const abBtnB = $("abB");
const abClearBtn = $("abClear");

function updateTimeDisplay(pos) {
  const p = (pos === undefined) ? (isPlaying && audioCtx ? audioCtx.currentTime - startedAt : pausedAt) : pos;
  if (timeCur) timeCur.textContent = formatTime(Math.max(0, Math.min(duration, p)));
}

function initTransport() {
  duration = buffer ? buffer.duration : 0;
  if (seekBar) { seekBar.value = 0; seekBar.disabled = !buffer; }
  if (restartBtn) restartBtn.disabled = !buffer;
  if (timeTotal) timeTotal.textContent = formatTime(duration);
  updateTimeDisplay(0);
  // reset + enable A/B compare for the new track (both start as the clean version)
  abSlots.A = AB_DEFAULT();
  abSlots.B = AB_DEFAULT();
  abActive = "A";
  [abBtnA, abBtnB, abClearBtn].forEach((b) => { if (b) b.disabled = !buffer; });
  updateABUI();
}

// Capture the current live EQ + tuning/pitch state.
function abSnapshot() {
  return {
    lo: parseFloat($("eqLow").value) || 0,
    mid: parseFloat($("eqMid").value) || 0,
    hi: parseFloat($("eqHigh").value) || 0,
    semi: pitchSemitones,
    mode: pitchMode,
  };
}

// Restore a saved state to the live controls.
function abApply(s) {
  $("eqLow").value = s.lo; $("eqLowVal").textContent = fmt(s.lo); if (lowFilter) lowFilter.gain.value = s.lo;
  $("eqMid").value = s.mid; $("eqMidVal").textContent = fmt(s.mid); if (midFilter) midFilter.gain.value = s.mid;
  $("eqHigh").value = s.hi; $("eqHighVal").textContent = fmt(s.hi); if (highFilter) highFilter.gain.value = s.hi;

  pitchMode = s.mode;
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === s.mode));
  const applyRow = $("pitchApplyRow");
  if (applyRow) applyRow.style.display = (s.mode === "pitch") ? "flex" : "none";
  pitchSemitones = s.semi;
  applyPitchShift();
}

function updateABUI() {
  if (abBtnA) abBtnA.classList.toggle("active", abActive === "A");
  if (abBtnB) abBtnB.classList.toggle("active", abActive === "B");
}

function abSwitch(target) {
  if (!buffer || target === abActive) return;
  abSlots[abActive] = abSnapshot();  // keep the current side's edits
  abActive = target;
  abApply(abSlots[target]);
  updateABUI();
}

if (abBtnA) abBtnA.addEventListener("click", () => abSwitch("A"));
if (abBtnB) abBtnB.addEventListener("click", () => abSwitch("B"));
if (abClearBtn) abClearBtn.addEventListener("click", () => {
  abSlots.A = AB_DEFAULT();
  abSlots.B = AB_DEFAULT();
  abActive = "A";
  abApply(abSlots.A);
  updateABUI();
});

if (seekBar) {
  // 'input' fires continuously during a drag; 'change' on release.
  seekBar.addEventListener("input", () => {
    if (!buffer) return;
    if (!isScrubbing) {
      isScrubbing = true;
      wasPlayingBeforeSeek = isPlaying;
      if (isPlaying && source) {
        source.onended = null;
        try { source.stop(); } catch (e) { /* already stopped */ }
        isPlaying = false;
      }
    }
    pausedAt = (parseFloat(seekBar.value) / 1000) * duration;
    updateTimeDisplay(pausedAt);
  });
  seekBar.addEventListener("change", () => {
    if (!isScrubbing) return;
    isScrubbing = false;
    if (wasPlayingBeforeSeek) {
      startSource(pausedAt); // resume playback from the new point
    } else {
      playBtn.disabled = !buffer;
      pauseBtn.disabled = true;
    }
    wasPlayingBeforeSeek = false;
  });
}

if (restartBtn) {
  restartBtn.addEventListener("click", () => {
    if (!buffer) return;
    pausedAt = 0;
    if (seekBar) seekBar.value = 0;
    updateTimeDisplay(0);
    startSource(0); // jump to the top and play
  });
}

// ---- Export: render current EQ + pitch/tuning to a downloadable WAV ----
// Renders offline (silent, faster than realtime) through the same filter chain
// the live graph uses, so the download matches what you hear.
async function renderVariation() {
  ensureContext();
  const rate = (pitchMode === "speed") ? Math.pow(2, pitchSemitones / 12) : 1.0;
  const sr = buffer.sampleRate;
  const outLen = Math.max(1, Math.ceil(buffer.length / rate) + 1);
  const off = new OfflineAudioContext(buffer.numberOfChannels, outLen, sr);

  const src = off.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;

  const lo = off.createBiquadFilter();
  lo.type = "lowshelf"; lo.frequency.value = 200;
  lo.gain.value = lowFilter ? lowFilter.gain.value : 0;
  const md = off.createBiquadFilter();
  md.type = "peaking"; md.frequency.value = 1500; md.Q.value = 0.9;
  md.gain.value = midFilter ? midFilter.gain.value : 0;
  const hi = off.createBiquadFilter();
  hi.type = "highshelf"; hi.frequency.value = 8000;
  hi.gain.value = highFilter ? highFilter.gain.value : 0;
  const g = off.createGain();
  g.gain.value = gainNode ? gainNode.gain.value : 0.9;

  src.connect(lo); lo.connect(md); md.connect(hi); hi.connect(g); g.connect(off.destination);
  src.start();
  return off.startRendering();
}

// 16-bit PCM WAV encoder — no libraries.
function audioBufferToWav(buf) {
  const numCh = buf.numberOfChannels;
  const len = buf.length;
  const sr = buf.sampleRate;
  const blockAlign = numCh * 2;
  const dataSize = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  let o = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(o++, s.charCodeAt(i)); };
  const u32 = (v) => { view.setUint32(o, v, true); o += 4; };
  const u16 = (v) => { view.setUint16(o, v, true); o += 2; };

  str("RIFF"); u32(36 + dataSize); str("WAVE");
  str("fmt "); u32(16); u16(1); u16(numCh); u32(sr); u32(sr * blockAlign); u16(blockAlign); u16(16);
  str("data"); u32(dataSize);

  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

function variationName() {
  const parts = [currentFileName];
  const eqOn = lowFilter && (lowFilter.gain.value || midFilter.gain.value || highFilter.gain.value);
  if (eqOn) parts.push("EQ");
  if (Math.abs(pitchSemitones) > 0.001) parts.push(Math.round(currentTuningHz) + "Hz");
  if (parts.length === 1) parts.push("original");
  return parts.join("_") + ".wav";
}

const downloadBtn = $("downloadBtn");
const downloadStatus = $("downloadStatus");
if (downloadBtn) {
  downloadBtn.addEventListener("click", async () => {
    if (!buffer) return;
    downloadBtn.disabled = true;
    if (downloadStatus) { downloadStatus.textContent = "Rendering…"; downloadStatus.style.color = "var(--accent)"; }
    try {
      const rendered = await renderVariation();
      const blob = audioBufferToWav(rendered);
      const name = variationName();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      const mb = (blob.size / 1048576).toFixed(1);
      if (downloadStatus) { downloadStatus.textContent = "Saved " + name + " (" + mb + " MB)"; downloadStatus.style.color = "var(--good)"; }
    } catch (err) {
      console.error("Export failed:", err);
      if (downloadStatus) { downloadStatus.textContent = "Export failed — see console."; downloadStatus.style.color = "var(--bad)"; }
    }
    downloadBtn.disabled = false;
  });
}

// Reusable by the Stems tab: encode any AudioBuffer to WAV and download it.
window.luxenDownloadBuffer = (buf, suffix) => {
  const blob = audioBufferToWav(buf);
  const name = currentFileName + "_" + suffix + ".wav";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
};

// ---- Public API for the Field tab (field.js) ----
// Kept tiny and explicit so the two files stay decoupled.
window.luxenSeek = (seconds) => { if (buffer) startSource(seconds); };
window.luxenPosition = () => (isPlaying && audioCtx ? audioCtx.currentTime - startedAt : pausedAt);
window.luxenDuration = () => duration;
window.luxenIsPlaying = () => isPlaying;
window.luxenStop = () => {
  if (isPlaying && source) {
    try { source.onended = null; source.stop(); } catch (e) { /* already stopped */ }
    pausedAt = audioCtx.currentTime - startedAt;
    isPlaying = false;
    playBtn.disabled = false;
    pauseBtn.disabled = true;
  }
};

function applyPitchShift() {
  const rate = Math.pow(2, pitchSemitones / 12);
  $("pitchVal").textContent = (pitchSemitones >= 0 ? "+" : "") + pitchSemitones.toFixed(2) + " st  -  x" + rate.toFixed(4);
  $("pitchSlider").value = pitchSemitones;
  currentTuningHz = 440 * rate;
  $("currentTuning").textContent = currentTuningHz.toFixed(1) + " Hz";

  if (pitchMode === "speed") {
    if (source) source.playbackRate.value = rate;
  } else {
    if (source) source.playbackRate.value = 1.0;
    const statusEl = $("pitchStatus");
    if (statusEl) {
      statusEl.textContent = (Math.abs(pitchSemitones) < 0.001)
        ? "At original pitch."
        : "Pitch target set. Click Apply to process audio.";
      statusEl.style.color = "var(--warn)";
    }
  }
}

$("pitchSlider").addEventListener("input", () => {
  pitchSemitones = parseFloat($("pitchSlider").value);
  applyPitchShift();
});

document.querySelectorAll("[data-tuning]").forEach(btn => {
  btn.addEventListener("click", () => {
    const targetHz = parseFloat(btn.dataset.tuning);
    const rate = targetHz / 440;
    pitchSemitones = 12 * Math.log2(rate);
    applyPitchShift();
  });
});

$("resetPitch").addEventListener("click", () => {
  pitchSemitones = 0;
  applyPitchShift();
});

function detectDominantFrequency() {
  if (!analyser || !audioCtx) return;
  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(data);
  const nyquist = audioCtx.sampleRate / 2;
  const binHz = nyquist / data.length;
  const minBin = Math.max(1, Math.floor(60 / binHz));
  const maxBin = Math.min(data.length - 1, Math.floor(1500 / binHz));
  let peakDb = -Infinity;
  let peakBin = minBin;
  for (let i = minBin; i <= maxBin; i++) {
    if (data[i] > peakDb) { peakDb = data[i]; peakBin = i; }
  }
  if (peakDb < -75) return;

  const hz = peakBin * binHz;
  freqHistory.push(hz);
  if (freqHistory.length > 30) freqHistory.shift();

  const sorted = [...freqHistory].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  $("detectedFreq").textContent = median.toFixed(0) + " Hz";

  let folded = median;
  while (folded > 880) folded /= 2;
  while (folded < 220) folded *= 2;
  const refs = [
    { hz: 432, label: "432 Hz tuning" },
    { hz: 440, label: "standard 440 Hz tuning" },
    { hz: 444, label: "444 Hz tuning" },
    { hz: 528, label: "528 Hz tuning" }
  ];
  let bestRef = null, bestDelta = Infinity;
  for (const r of refs) {
    const d = Math.abs(folded - r.hz);
    if (d < bestDelta) { bestDelta = d; bestRef = r; }
  }
  if (bestRef && bestDelta < 8) {
    $("detectedHint").textContent = "Close to " + bestRef.label + ".";
  } else {
    const midi = 69 + 12 * Math.log2(median / 440);
    const noteNames = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const noteIdx = ((Math.round(midi) % 12) + 12) % 12;
    const octave = Math.floor(Math.round(midi) / 12) - 1;
    $("detectedHint").textContent = "~" + noteNames[noteIdx] + octave + " (between standard tunings)";
  }
}

applyPitchShift();

document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    pitchMode = btn.dataset.mode;
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    if (pitchMode === "speed") {
      $("pitchApplyRow").style.display = "none";
      $("modeNote").innerHTML =
        '<b style="color: var(--accent);">Speed mode:</b> the pitch shifter uses Web Audio playbackRate &mdash; instant and real-time, but tempo changes with pitch (like a tape varispeed). Switch to Pitch mode for tempo-preserving phase-vocoder processing.';
      if (originalBuffer) buffer = originalBuffer;
    } else {
      $("pitchApplyRow").style.display = "flex";
      $("modeNote").innerHTML =
        '<b style="color: var(--accent);">Pitch mode:</b> tempo-preserving phase-vocoder processing. Adjust the slider or click a tuning preset, then press <b>Apply</b>. Processing takes 1 to 5 s depending on track length. Some phasiness on transients is normal &mdash; characteristic phase-vocoder artifact (improvable with phase-locking, on the roadmap).';
    }
    applyPitchShift();
  });
});

$("applyPitchBtn").addEventListener("click", async () => {
  if (!originalBuffer) {
    $("pitchStatus").textContent = "Load a track first.";
    $("pitchStatus").style.color = "var(--bad)";
    return;
  }
  if (isPlaying) {
    source.onended = null;
    source.stop();
    isPlaying = false;
    pausedAt = 0;
    playBtn.disabled = false;
    pauseBtn.disabled = true;
  }
  $("applyPitchBtn").disabled = true;
  $("pitchStatus").textContent = "Processing... (phase vocoder)";
  $("pitchStatus").style.color = "var(--accent)";
  await new Promise(r => requestAnimationFrame(r));

  try {
    const t0 = performance.now();
    const newBuffer = await phaseVocoderPitchShift(originalBuffer, pitchSemitones);
    buffer = newBuffer;
    const ms = (performance.now() - t0).toFixed(0);
    $("pitchStatus").textContent = Math.abs(pitchSemitones) < 0.001
      ? "Reverted to original. Press Play."
      : "Done in " + ms + " ms. Press Play.";
    $("pitchStatus").style.color = "var(--good)";
  } catch (err) {
    console.error("Phase vocoder failed:", err);
    $("pitchStatus").textContent = "Processing failed -- using original audio.";
    $("pitchStatus").style.color = "var(--bad)";
    buffer = originalBuffer;
  }
  $("applyPitchBtn").disabled = false;
});

async function phaseVocoderPitchShift(buf, semitones) {
  if (Math.abs(semitones) < 0.001) return buf;
  const ratio = Math.pow(2, semitones / 12);
  const sampleRate = buf.sampleRate;
  const numChannels = buf.numberOfChannels;

  const processedChannels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const input = buf.getChannelData(ch);
    const stretched = timeStretchPV(input, 1 / ratio);
    const resampled = linearResample(stretched, ratio);
    processedChannels.push(resampled);
    if (ch < numChannels - 1) await new Promise(r => setTimeout(r, 0));
  }

  const targetLength = Math.max(...processedChannels.map(c => c.length));
  const newBuf = audioCtx.createBuffer(numChannels, targetLength, sampleRate);
  for (let ch = 0; ch < numChannels; ch++) {
    if (processedChannels[ch].length < targetLength) {
      const padded = new Float32Array(targetLength);
      padded.set(processedChannels[ch]);
      newBuf.copyToChannel(padded, ch);
    } else {
      newBuf.copyToChannel(processedChannels[ch], ch);
    }
  }
  return newBuf;
}

function timeStretchPV(input, stretchFactor) {
  const FFT_SIZE = 2048;
  const ANALYSIS_HOP = FFT_SIZE / 4;
  const SYNTH_HOP = Math.max(1, Math.round(ANALYSIS_HOP * stretchFactor));

  const numFrames = Math.floor((input.length - FFT_SIZE) / ANALYSIS_HOP);
  if (numFrames <= 0) return input.slice();

  const outputLength = numFrames * SYNTH_HOP + FFT_SIZE;
  const output = new Float32Array(outputLength);
  const normBuf = new Float32Array(outputLength);

  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));
  }

  const halfBins = FFT_SIZE / 2 + 1;
  const lastPhaseIn = new Float32Array(halfBins);
  const accPhaseOut = new Float32Array(halfBins);
  const expectedAdv = new Float32Array(halfBins);
  for (let bin = 0; bin < halfBins; bin++) {
    expectedAdv[bin] = 2 * Math.PI * bin * ANALYSIS_HOP / FFT_SIZE;
  }

  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const TWO_PI = 2 * Math.PI;
  const invN = 1 / FFT_SIZE;

  for (let frame = 0; frame < numFrames; frame++) {
    const inOff = frame * ANALYSIS_HOP;

    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = input[inOff + i] * hann[i];
      imag[i] = 0;
    }
    fft(real, imag);

    for (let bin = 0; bin < halfBins; bin++) {
      const re = real[bin], im = imag[bin];
      const mag = Math.sqrt(re * re + im * im);
      const phase = Math.atan2(im, re);

      let diff = phase - lastPhaseIn[bin] - expectedAdv[bin];
      diff -= TWO_PI * Math.round(diff / TWO_PI);
      const trueAdv = expectedAdv[bin] + diff;
      lastPhaseIn[bin] = phase;

      accPhaseOut[bin] += trueAdv * SYNTH_HOP / ANALYSIS_HOP;

      real[bin] = mag * Math.cos(accPhaseOut[bin]);
      imag[bin] = mag * Math.sin(accPhaseOut[bin]);
    }

    for (let bin = halfBins; bin < FFT_SIZE; bin++) {
      real[bin] = real[FFT_SIZE - bin];
      imag[bin] = -imag[FFT_SIZE - bin];
    }

    for (let i = 0; i < FFT_SIZE; i++) imag[i] = -imag[i];
    fft(real, imag);
    for (let i = 0; i < FFT_SIZE; i++) real[i] *= invN;

    const outOff = frame * SYNTH_HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      output[outOff + i] += real[i] * hann[i];
      normBuf[outOff + i] += hann[i] * hann[i];
    }
  }

  for (let i = 0; i < outputLength; i++) {
    if (normBuf[i] > 1e-10) output[i] /= normBuf[i];
  }
  return output;
}

function linearResample(input, ratio) {
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const srcInt = Math.floor(srcIdx);
    const frac = srcIdx - srcInt;
    const a = input[srcInt] || 0;
    const b = input[srcInt + 1] || 0;
    output[i] = a + (b - a) * frac;
  }
  return output;
}
