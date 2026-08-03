"use strict";

/*
 * separate.js — hand-rolled Vocal / Instrumental separation.
 *
 * No neural network, no server, no upload. Technique: spectral center-channel
 * extraction. Lead vocals sit dead-center in a stereo mix, so in the frequency
 * domain the vocal energy is the content that appears EQUALLY in left and right.
 *
 * Per time-frequency bin we measure how balanced the bin is between channels
 * (1 = centered, 0 = hard-panned), square it into a soft mask, and gate it to
 * the vocal band (~110 Hz–14 kHz) so centered bass/kick stay out of the vocal.
 * Vocal = mask * mid; Instrumental = original - vocal, so the two sum back to
 * the source exactly.
 *
 * This is frequency-selective, which is why it's cleaner than a blunt L-R
 * karaoke subtraction. It's still DSP, not ML — expect residual bleed on
 * heavily-panned or mono material.
 *
 * Exposes window.luxenSeparate(buffer, onProgress) -> Promise<{vocal, instrumental}>.
 */

(function () {
  const N = 4096;          // larger FFT = tighter low-freq bins = less bass bleed
  const HOP = 1024;        // 75% overlap (COLA-satisfying with Hann)
  const HALF = N / 2 + 1;
  const VOCAL_LO = 120;    // Hz — below this stays in the instrumental (bass, kick)
  const VOCAL_HI = 14000;  // Hz — above this too (cymbal air)

  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));

  const nextTick = () => new Promise((r) => setTimeout(r, 0));

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
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

  function inverse(re, im) {
    for (let i = 0; i < N; i++) im[i] = -im[i];
    fft(re, im);
    const inv = 1 / N;
    for (let i = 0; i < N; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
  }

  // Mirror bins [HALF..N) as the Hermitian conjugate of [1..N/2) so the
  // inverse FFT yields a real signal.
  function mirror(re, im) {
    for (let b = HALF; b < N; b++) { re[b] = re[N - b]; im[b] = -im[N - b]; }
  }

  async function separate(buffer, onProgress) {
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const frames = Math.max(1, Math.floor((len - N) / HOP) + 1);

    const vocal = new Float32Array(len);
    const instL = new Float32Array(len);
    const instR = new Float32Array(len);
    const norm = new Float32Array(len);

    // per-frame scratch
    const reL = new Float32Array(N), imL = new Float32Array(N);
    const reR = new Float32Array(N), imR = new Float32Array(N);
    const reV = new Float32Array(N), imV = new Float32Array(N);
    const reA = new Float32Array(N), imA = new Float32Array(N); // instrumental L
    const reB = new Float32Array(N), imB = new Float32Array(N); // instrumental R

    // Precompute which bins fall in the vocal band.
    const inBand = new Uint8Array(HALF);
    for (let b = 0; b < HALF; b++) {
      const f = b * sr / N;
      inBand[b] = (f >= VOCAL_LO && f <= VOCAL_HI) ? 1 : 0;
    }

    onProgress && onProgress(0.02, "Analysing stereo image…");
    const EPS = 1e-9;

    for (let f = 0; f < frames; f++) {
      if ((f & 63) === 0) { onProgress && onProgress(0.02 + (f / frames) * 0.96, "Extracting vocal…"); await nextTick(); }
      const off = f * HOP;
      for (let i = 0; i < N; i++) {
        const w = hann[i];
        const s = off + i;
        reL[i] = (s < len ? L[s] : 0) * w; imL[i] = 0;
        reR[i] = (s < len ? R[s] : 0) * w; imR[i] = 0;
      }
      fft(reL, imL);
      fft(reR, imR);

      for (let b = 0; b < HALF; b++) {
        const magL = Math.hypot(reL[b], imL[b]);
        const magR = Math.hypot(reR[b], imR[b]);
        // balance: 1 when equal in both channels (centered), 0 when hard-panned
        let bal = 1 - Math.abs(magL - magR) / (magL + magR + EPS);
        let mask = inBand[b] ? bal * bal : 0; // sharpen + band-gate
        const midRe = 0.5 * (reL[b] + reR[b]);
        const midIm = 0.5 * (imL[b] + imR[b]);
        const vRe = mask * midRe, vIm = mask * midIm;
        reV[b] = vRe; imV[b] = vIm;
        reA[b] = reL[b] - vRe; imA[b] = imL[b] - vIm;
        reB[b] = reR[b] - vRe; imB[b] = imR[b] - vIm;
      }
      mirror(reV, imV); mirror(reA, imA); mirror(reB, imB);
      inverse(reV, imV); inverse(reA, imA); inverse(reB, imB);

      for (let i = 0; i < N; i++) {
        const s = off + i;
        if (s >= len) break;
        const w = hann[i];
        vocal[s] += reV[i] * w;
        instL[s] += reA[i] * w;
        instR[s] += reB[i] * w;
        norm[s] += w * w;
      }
    }

    for (let i = 0; i < len; i++) {
      if (norm[i] > 1e-8) { vocal[i] /= norm[i]; instL[i] /= norm[i]; instR[i] /= norm[i]; }
    }

    onProgress && onProgress(1, "Done.");
    return {
      sampleRate: sr,
      length: len,
      vocal: [vocal],              // mono center
      instrumental: [instL, instR] // stereo remainder
    };
  }

  window.luxenSeparate = separate;
})();
