# Luxen Mix Analyzer — Design System

Instructions for building the next screen so it stays consistent with this one. Read this before extending the UI.

## Point of view

**Reference lineage:** scientific / laboratory instrumentation — the panel of a spectrum analyser or a mastering meter, not a consumer music app. Chosen because the product *is* a measurement tool: it reports LUFS, frequency balance, and spectral data, so the interface should read like calibrated equipment.

**Mood:** quiet, precise, technical. Confidence through restraint, not decoration.

**Layout archetype:** data/proof-first, tabbed workspace. The evidence (the numbers, the spectrum) leads; there is no marketing hero. Three tabs — Analyze / Field / Stems — each a self-contained instrument panel.

**The one unconventional commitment:** a slow ambient hue cycle. A single animated `--hue` drives the accent color, an ambient drifting background field, and the translucent panel tints in unison — the whole instrument "breathes" through the spectrum over 30s. It is deliberately restrained (held saturation/lightness) so it reads as premium ambient, not RGB-gamer.

## Palette

Colors are cyan-tinted neutrals over a near-black field. The accent is HSL-driven so it can animate; everything else is fixed.

| Token | Value | Job |
| --- | --- | --- |
| `--field` | `#06080d` | Dominant background field (behind the ambient layer) |
| `--card` | `rgba(12,17,25,0.5)` | Translucent frosted panels — ambient glows through |
| `--bg` | `rgba(13,19,28,0.72)` | Inset readout panels (kept more opaque for legibility) |
| `--ink` | `#d7e3ea` | Primary text |
| `--muted` | `#7f929e` | Secondary/label text |
| `--faint` | `#566470` | Tertiary/hint text |
| `--accent` | `hsl(var(--hue) 66% 66%)` | Interactive states, key data, CTAs — **animated** |
| `--good` | `#58e6c8` | Positive status — **fixed, never cycles** |
| `--warn` | `#ffc14a` | Caution status — **fixed** |
| `--bad` | `#ff6b4a` | Negative status — **fixed** |

**Rules that must hold on future screens:**

- Semantic status colors (`--good` / `--warn` / `--bad`) are **fixed on purpose** — a "good" badge must never turn red mid-cycle. Only `--accent` rides the hue loop.
- **Accent lightness must stay at 66%.** This is the measured minimum that keeps accent-as-text at or above WCAG AA 4.5:1 across the *entire* hue wheel (worst case, the blue phase, is ~4.8:1). Do not lower it.

## Type

Two families, loaded via Google Fonts:

```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
```

- **IBM Plex Mono** (`--font-data`) — all data, numbers, labels, and readouts. Use `font-variant-numeric: tabular-nums` on any figure that updates so it doesn't jitter.
- **Space Grotesk** (`--font-chrome`) — headings and interface chrome.

Labels are uppercase mono with wide tracking (`letter-spacing: 0.14em`); big readouts are large mono; body is Space Grotesk.

## Structure & motifs

- **Corner radius:** 6px on panels, 3px on buttons/controls. Sharp, instrument-like.
- **Rules/borders:** hairlines at `rgba(120,200,220,0.09)`; panel borders mix ~16% accent into the hairline so they pick up the live hue faintly.
- **Depth:** frosted glass — `backdrop-filter: blur(14px) saturate(1.15)` on panels over the ambient field, plus a soft drop shadow. Not flat, not heavy card-shadows.
- Reusable motifs, by name: (1) **brand chip** — a phosphor bar + tracked-out "LUXEN"; (2) **section header** — small uppercase mono label preceded by a short accent tick; (3) **inset readout panel** — large mono number with a muted caption; (4) **ambient field** — the drifting hue-linked background.

## Component craft

Native controls are restyled, not replaced: `input[type=range]` sliders, `<button>` elements, and file inputs all use `appearance: none` so keyboard operability survives. Non-happy-path states exist — decode-failure message on bad files, disabled states on transport before a track loads, progress states during separation and export.

## Accessibility floor (hold to these)

- Contrast ≥ 4.5:1 for text, verified across the full animated hue range — see the accent-lightness rule above.
- Every interactive element has a visible `:focus-visible` outline.
- The interactive canvas has an `aria-label`; the decorative spectrum canvas is `aria-hidden`.
- `prefers-reduced-motion: reduce` freezes the hue cycle and the ambient drift to a static phosphor state.

## Copy voice

Technical, plain, specific. State the standard, not a vibe: "integrated loudness, ITU-R BS.1770-4" not "pro-grade sound." Name real numbers. Avoid marketing adjectives ("powerful," "seamless"). Example lines that fit: *"Local only — no uploads."* / *"See the song's dominant frequency live."*
