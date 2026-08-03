"use strict";

/*
 * field.js — the "Field" tab: a spatial map of the loaded track.
 *
 * The track is sliced into short windows. Each window is measured (spectral
 * centroid = brightness, RMS = energy) and plotted as a node: X by brightness
 * on a log scale, Y by energy in dB. Consecutive windows are joined so you can
 * see the song's path through timbre space. Clicking a node seeks playback to
 * that moment (via the small API app.js exposes on window), and a ring tracks
 * the current playback position live.
 *
 * Self-contained: its own radix-2 FFT, no dependency on app.js internals beyond
 * the public window.luxen* seek/position API.
 */

(function () {
  const canvas = document.getElementById("fieldCanvas");
  const emptyEl = document.getElementById("fieldEmpty");
  const hudEl = document.getElementById("fieldHud");
  const fieldTab = document.getElementById("tab-field");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // ---- world + camera --------------------------------------------------
  const WORLD = { w: 1600, h: 1000, margin: 130 };
  const ZOOM = { min: 0.4, max: 8 };
  const cam = { x: WORLD.w / 2, y: WORLD.h / 2, zoom: 0.62 };

  let nodes = [];
  let dpr = 1;
  let dirty = true;
  let hoverIdx = -1;
  let selectedIdx = -1;

  const markDirty = () => { dirty = true; };

  // ---- radix-2 FFT (in place) -----------------------------------------
  function fft(re, im) {
    const N = re.length;
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1, ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const tr = cr * re[i + k + half] - ci * im[i + k + half];
          const ti = cr * im[i + k + half] + ci * re[i + k + half];
          re[i + k + half] = re[i + k] - tr; im[i + k + half] = im[i + k] - ti;
          re[i + k] += tr; im[i + k] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // ---- analysis: buffer -> nodes --------------------------------------
  function analyseTrack(buffer) {
    const FFT = 4096;
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const chs = buffer.numberOfChannels;

    // Mono downmix once.
    const mono = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i];
    }
    if (chs > 1) for (let i = 0; i < len; i++) mono[i] /= chs;

    const TARGET = 150;
    const hop = Math.max(FFT, Math.floor((len - FFT) / TARGET) || FFT);

    const hann = new Float32Array(FFT);
    for (let i = 0; i < FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT - 1));

    const re = new Float32Array(FFT);
    const im = new Float32Array(FFT);
    const out = [];

    for (let start = 0; start + FFT <= len; start += hop) {
      let sumSq = 0;
      for (let i = 0; i < FFT; i++) {
        const s = mono[start + i];
        sumSq += s * s;
        re[i] = s * hann[i];
        im[i] = 0;
      }
      fft(re, im);

      let num = 0, den = 0;
      for (let bin = 1; bin < FFT / 2; bin++) {
        const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
        const hz = bin * sr / FFT;
        num += hz * mag;
        den += mag;
      }
      const centroid = den > 0 ? num / den : 0;
      const rms = Math.sqrt(sumSq / FFT);
      out.push({
        t: start / sr,
        centroid,
        rms,
        rmsDb: rms > 0 ? 20 * Math.log10(rms) : -90,
      });
    }
    return out;
  }

  // ---- layout: node -> world coords -----------------------------------
  const C_MIN = 80, C_MAX = 12000, DB_MIN = -50, DB_MAX = -6;
  const logMin = Math.log(C_MIN), logMax = Math.log(C_MAX);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function layout(list) {
    for (const n of list) {
      const c = clamp(n.centroid || C_MIN, C_MIN, C_MAX);
      const nx = (Math.log(c) - logMin) / (logMax - logMin);
      const db = clamp(Number.isFinite(n.rmsDb) ? n.rmsDb : DB_MIN, DB_MIN, DB_MAX);
      const ny = 1 - (db - DB_MIN) / (DB_MAX - DB_MIN);
      n.wx = WORLD.margin + nx * (WORLD.w - 2 * WORLD.margin);
      n.wy = WORLD.margin + ny * (WORLD.h - 2 * WORLD.margin);
    }
    return list;
  }

  // ---- coordinate transforms ------------------------------------------
  function w2s(wx, wy) {
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    return { x: (wx - cam.x) * cam.zoom + vw / 2, y: (wy - cam.y) * cam.zoom + vh / 2 };
  }
  function s2w(sx, sy) {
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    return { x: (sx - vw / 2) / cam.zoom + cam.x, y: (sy - vh / 2) / cam.zoom + cam.y };
  }

  // ---- color: time gradient phosphor -> amber -------------------------
  function timeColor(f, a) {
    // f in [0,1]; cyan (88,230,200) -> amber (255,193,74)
    const r = Math.round(88 + (255 - 88) * f);
    const g = Math.round(230 + (193 - 230) * f);
    const b = Math.round(200 + (74 - 200) * f);
    return `rgba(${r},${g},${b},${a})`;
  }

  // ---- rendering ------------------------------------------------------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    markDirty();
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // backdrop grid
    ctx.fillStyle = "#080b11";
    ctx.fillRect(0, 0, w, h);
    drawGrid(w, h);

    if (nodes.length) {
      // trajectory path
      ctx.beginPath();
      for (let i = 0; i < nodes.length; i++) {
        const p = w2s(nodes[i].wx, nodes[i].wy);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = "rgba(120,200,220,0.14)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // nodes
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const p = w2s(n.wx, n.wy);
        const f = nodes.length > 1 ? i / (nodes.length - 1) : 0;
        const r = 3.4 + n.rms * 26;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = timeColor(f, i === hoverIdx ? 0.98 : 0.72);
        ctx.fill();
        if (i === selectedIdx) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
          ctx.strokeStyle = "#e8ecf3";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // live playhead ring on nearest node to current position
      const pos = (typeof window.luxenPosition === "function") ? window.luxenPosition() : 0;
      const ph = nearestByTime(pos);
      if (ph >= 0) {
        const p = w2s(nodes[ph].wx, nodes[ph].wy);
        const pulse = 8 + 4 * Math.sin(performance.now() / 220);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 + nodes[ph].rms * 26 + pulse, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(88,230,200,0.85)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    drawAxes(w, h);
    ctx.restore();
  }

  function drawGrid(w, h) {
    const major = 100 * cam.zoom;
    gridLines(w, h, major / 5, "rgba(120,200,220,0.025)");
    gridLines(w, h, major, "rgba(120,200,220,0.06)");
  }
  function gridLines(w, h, spacing, color) {
    if (spacing < 7) return;
    const ox = ((-cam.x * cam.zoom + w / 2) % spacing + spacing) % spacing;
    const oy = ((-cam.y * cam.zoom + h / 2) % spacing + spacing) % spacing;
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = ox; x < w; x += spacing) { ctx.moveTo((x | 0) + 0.5, 0); ctx.lineTo((x | 0) + 0.5, h); }
    for (let y = oy; y < h; y += spacing) { ctx.moveTo(0, (y | 0) + 0.5); ctx.lineTo(w, (y | 0) + 0.5); }
    ctx.stroke();
  }

  const MONO = "'IBM Plex Mono', ui-monospace, monospace";
  function drawAxes(w, h) {
    ctx.font = "500 9px " + MONO;
    ctx.fillStyle = "rgba(88,230,200,0.42)";
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText("BRIGHTNESS · SPECTRAL CENTROID [Hz]", 14, h - 10);
    ctx.save();
    ctx.translate(13, h / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText("ENERGY · RMS [dB]", 0, 0);
    ctx.restore();
    ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(88,230,200,0.5)";
    ctx.fillText("ZOOM " + cam.zoom.toFixed(2) + "×", w - 14, 12);
  }

  // ---- helpers --------------------------------------------------------
  function nearestByTime(t) {
    if (!nodes.length) return -1;
    let best = -1, bd = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = Math.abs(nodes[i].t - t);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function hitTest(sx, sy) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const p = w2s(nodes[i].wx, nodes[i].wy);
      const r = Math.max(8, (3.4 + nodes[i].rms * 26) * cam.zoom * 0.5 + 6);
      if (Math.hypot(sx - p.x, sy - p.y) <= r) return i;
    }
    return -1;
  }
  function fmtTime(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60).toString().padStart(2, "0");
    return m + ":" + sec;
  }

  // ---- interaction ----------------------------------------------------
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    drag = { sx: e.clientX - rect.left, sy: e.clientY - rect.top, moved: false, hit: hitTest(e.clientX - rect.left, e.clientY - rect.top) };
  });
  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (drag) {
      const dx = sx - drag.sx, dy = sy - drag.sy;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.moved) {
        cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom;
        drag.sx = sx; drag.sy = sy;
        canvas.style.cursor = "grabbing";
        markDirty();
      }
    } else {
      const hit = hitTest(sx, sy);
      if (hit !== hoverIdx) { hoverIdx = hit; markDirty(); }
      canvas.style.cursor = hit >= 0 ? "pointer" : "grab";
      if (hit >= 0) {
        const n = nodes[hit];
        hudEl.textContent = `${fmtTime(n.t)}   ${Math.round(n.centroid)} Hz   ${n.rmsDb.toFixed(1)} dB`;
      } else if (hudEl.textContent && hoverIdx < 0) {
        hudEl.textContent = "";
      }
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const wasDrag = drag && drag.moved;
    canvas.style.cursor = "grab";
    drag = null;
    if (wasDrag) return;
    const hit = hitTest(sx, sy);
    if (hit >= 0) {
      selectedIdx = hit;
      if (typeof window.luxenSeek === "function") window.luxenSeek(nodes[hit].t);
      markDirty();
    }
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = s2w(sx, sy);
    cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0016), ZOOM.min, ZOOM.max);
    const after = s2w(sx, sy);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
    markDirty();
  }, { passive: false });

  // keyboard: arrows pan, +/- zoom
  canvas.addEventListener("keydown", (e) => {
    const step = 80 / cam.zoom;
    if (e.key === "ArrowLeft") { cam.x -= step; markDirty(); }
    else if (e.key === "ArrowRight") { cam.x += step; markDirty(); }
    else if (e.key === "ArrowUp") { cam.y -= step; markDirty(); }
    else if (e.key === "ArrowDown") { cam.y += step; markDirty(); }
    else if (e.key === "+" || e.key === "=") { cam.zoom = clamp(cam.zoom * 1.2, ZOOM.min, ZOOM.max); markDirty(); }
    else if (e.key === "-" || e.key === "_") { cam.zoom = clamp(cam.zoom / 1.2, ZOOM.min, ZOOM.max); markDirty(); }
    else return;
    e.preventDefault();
  });

  // ---- render loop: redraw on change, or continuously while playing ----
  function loop() {
    const playing = (typeof window.luxenIsPlaying === "function") && window.luxenIsPlaying();
    if (dirty || playing) { dirty = false; draw(); }
    requestAnimationFrame(loop);
  }

  // ---- wiring ----------------------------------------------------------
  window.onLuxenBufferLoaded = function (buffer) {
    if (emptyEl) emptyEl.textContent = "Analysing track…";
    // Defer so the label paints before the synchronous analysis runs.
    requestAnimationFrame(() => {
      nodes = layout(analyseTrack(buffer));
      selectedIdx = -1; hoverIdx = -1;
      if (emptyEl) emptyEl.style.display = nodes.length ? "none" : "flex";
      resize();
      markDirty();
    });
  };

  // The Field canvas has zero size while its tab is hidden; size it on show.
  if (fieldTab) fieldTab.addEventListener("click", () => setTimeout(() => { resize(); markDirty(); }, 0));
  window.addEventListener("resize", resize);

  resize();
  requestAnimationFrame(loop);
})();
