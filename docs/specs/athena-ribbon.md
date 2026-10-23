# Athena Ribbon: full spec

## Application integration

The supplied renderer lives at `knowledge-hub-web/public/athena/athena-ribbon.js` and is loaded once by the app. `AthenaRibbon.tsx` is the typed React equivalent of the supplied JSX wrapper; `useAthenaMood` shares chat events across instances. The graph also uses the ribbon. The original geometry, nine mood tables, strand counts, 380ms easing and cyan/glass palette are preserved intentionally.

Small runtime adaptations cancel hidden/offscreen RAF and timeout callbacks, allow the travelling overlay to pause explicitly, freeze time and pointer tracking in reduced motion, and stop reduced-motion frames after the shape settles. The optional `level` property drives listening ripple from the existing mic analyser. No animation or API dependency was added.

**Accepted-answer exception:** the backend can discard intermediate token streams. Athena therefore stays `thinking` until the successful final answer, rather than responding to provisional first tokens. This preserves the answer-redraw fix. Errors, evidence warnings, suggestions, positive feedback and completed actions drive the additional moods; no new confidence contract or sentiment model is assumed.

Only needed resting PNGs are shipped for the launcher, favicon and PWA (64/128px avatars are also available for notification consumers). The handoff's PNGs were exported at 2x their folder names; they are resized to their declared pixel dimensions. No email/notification-avatar consumer exists to replace. The old mark assets remain available for legacy links but are no longer loaded by the app.

`tests/athena-motion.html?ribbon` shows all nine moods with interactive hero/header/message examples. The supplied specification follows unchanged.

---

Athena is a glowing, twisted ribbon of light inside a faint glass sphere. She has no face. Emotion comes from the ribbon's shape, twist, motion and brightness. The reference implementation is `src/athena-ribbon.js`. It is a dependency-free custom element that draws with Canvas 2D. If this document and the source disagree, the source is correct.

Visual reference: `reference/visual-reference.png`. Contact sheet of all moods: `assets/contact-sheet.png`.

---

## 1. Usage

```html
<script src="athena-ribbon.js"></script>
<athena-ribbon mood="resting" size="240" track></athena-ribbon>
```

| Attribute | Values | Default | Notes |
|---|---|---|---|
| `mood` | `resting` `listening` `thinking` `answering` `happy` `curious` `unsure` `sorry` `excited` | `resting` | Unknown values fall back to `resting` |
| `state` | same | | Alias for `mood`, so chat-state code can set `state` |
| `size` | px | `240` | Square. Changing it rebuilds the canvases |
| `track` | boolean | off | Ribbon leans toward the pointer. Use on hero sizes only |
| `label` | text | per mood | Accessible name override |
| `silent` | boolean | off | Suppress screen-reader announcements |
| `still` | boolean | off | Render one settled frame and stop. For thumbnails and exports |

Property: `el.mood` (get/set). Static: `customElements.get('athena-ribbon').MOODS` (array of mood names).
Event: `athena-moodchange` with `{ detail: { from, to } }`. It bubbles and is composed.

### Recommended sizes
- Hero / empty state: 240–360 px with `track`
- Chat header / panel: 64–120 px
- Inline next to a message: 32–44 px. Strand count drops automatically below 60 px.

### Chat wiring
| App event | mood |
|---|---|
| Idle | `resting` |
| Mic open / user typing | `listening` |
| Request sent, awaiting tokens | `thinking` |
| Tokens streaming | `answering` |
| Stream done | `resting` (after ~1.5 s) |
| Request failed / no result | `sorry` |
| Low-confidence answer, needs clarification | `unsure` |
| User thanks / positive feedback | `happy` |
| Surfaced a suggestion / "did you mean" | `curious` |
| Task completed, milestone, celebration | `excited` |

Emotions are short-lived. Return to `resting` after 2–4 s unless the app state says otherwise.

---

## 2. Rendering structure

Shadow DOM, back to front:
1. **Sphere** `div`, inset `6%` of size, circular.
   - Background: `radial-gradient(circle, rgba(0,20,40,0) 55%, rgba(130,207,255,.07) 88%, rgba(186,230,255,.14) 100%)`
   - `box-shadow: inset 0 0 8%·s rgba(51,177,255,.10), 0 0 12%·s rgba(17,146,232,.10)`
   - Opacity `0.35 + 0.65 × sphere` (mood param).
2. **Glow canvas**: a copy of the main canvas each frame, CSS `filter: blur(max(2px, 3.5%·s))`, `mix-blend-mode: screen`, opacity 0.95.
3. **Main canvas**: the ribbon, drawn with `globalCompositeOperation = 'lighter'` (additive), so overlapping strands brighten where the ribbon turns edge-on. This produces the bright rims in the reference.

Canvas backing resolution is `size × min(2, devicePixelRatio)`.

Colours (Carbon cyan):
- Body strands `rgb(51,177,255)` (cyan 40)
- Edge strands `rgb(186,230,255)` (cyan 20)
- Sphere tints `rgba(130,207,255,…)` (cyan 30) and `rgba(17,146,232,…)` (cyan 50)

Recommended surface: very dark, `#0b0d10` to `#161616`. Additive light does not read on light backgrounds. On a light theme, place the ribbon in a dark circular well.

---

## 3. Geometry

The ribbon is a closed loop sampled at `N` points (`θ ∈ [0, 2π]`), drawn as `S` parallel strands across its width (`v ∈ [−1, 1]`).

| | size < 60 | size < 140 | otherwise |
|---|---|---|---|
| S (strands) | 10 | 22 | 36 |
| N (samples) | 90 | 150 | 150 |

All lengths are in units of `size`. With `p` = the current (eased) mood params, `t` = seconds since page load and `tt` = seconds since the last mood change:

**Centre line**
```
rr = R · (1 + lob·sin(lobes·θ + 0.4t) + (ripple + 0.03·talk)·sin(rf·θ − 7t))
x = rr·cosθ
y = rr·sinθ·squash
z = R·amp·sin(2θ + 0.6)
```

**Width with twist** (twist = 1 is a Möbius half-twist)
```
τ  = twist·θ/2 + spinPhase
r̂  = normalize(cosθ, sinθ·squash)
w  = W · (1 + 0.35·talk)
x += v·w·cosτ·r̂x
y += v·w·cosτ·r̂y
z += v·w·sinτ
```

**Bend** (smile > 0, frown < 0)
```
y −= bend · (x²/R² − 0.45) · R · 0.6
```

**Rotation**, applied in this order: yaw (around y), then pitch (around x), then roll (around z).
```
yaw   = yawPhase + yaw0 + shake + 0.5·pointerX
pitch = pitch + 0.4·pointerY
roll  = roll + lean·0.2·pointerX
```

**Perspective**: `f = 2.6 / (2.6 − z)`. Screen point = `centre + (X, Y)·f·scale`, where
```
scale   = size · p.scale · breathe · (1 + 0.06·talk)
centreX = size/2 + lean·0.03·size
centreY = size/2 + size·(−bounce + sink·0.06)
```

**Strand styling**
- Edge strands (`|v| > 0.93`): alpha `0.38 × bright`, width `max(0.8, 0.0045·size)`, edge colour.
- Body strands: alpha `0.10 × bright`, width `max(0.6, 0.003·size)`, body colour.
- Each strand is stroked in chunks of 10 samples, so alpha can vary along it:
  - depth `= 0.4 + 0.6 · clamp(z/(1.2R)·0.5 + 0.5, 0, 1)` (the back of the ribbon is dimmer)
  - key light `= clamp(0.95 + (0.8·dx − 0.5·dy)/(0.3·size), 0.45, 1.6)`, where dx, dy are the chunk's offset from centre (light from the upper right)
  - final alpha `= min(1, base × depth × light)`
- `lineCap: butt` (round caps cause bright dots at chunk joins with additive blending), `lineJoin: round`.

---

## 4. Motion

### Phases (accumulate every frame)
```
yawPhase  += yawSp · dt     (initial 0.6)
spinPhase += spin  · dt     (initial 0)
```

### Global oscillators
| Name | Formula | Notes |
|---|---|---|
| breathe | `1 + 0.03·sin(2πt/4.2)` | Always on |
| bounce | `p.bounce · |sin(4.2t)| · 0.05` | Happy, excited |
| shake | `p.shake · sin(5.2t) · max(0, sin(1.1t)) · 0.5` | Unsure: shakes in bursts with pauses |
| talk | `p.talk · (tt < 3 ? |sin 9tt|·(0.6 + 0.4 sin 3.3tt) : 0.15·|sin 2tt|)` | Answering: lively for 3 s, then a low murmur |

Replace `talk` with a real audio or token-rate level if you have one (0–1).

### Mood transitions
Every numeric param eases exponentially toward the new mood's target:
`p += (target − p) · (1 − e^(−dt/0.38))`, so about 1 s to fully settle. Phases keep running, so the ribbon morphs instead of cutting. `dt` is capped at 64 ms.

### Pointer tracking (`track`)
Normalised offset = (pointer − element centre) / `max(300, 1.6·size)`, clamped to ±1. Smoothed per frame with factor 0.06. Ignored after 4 s without pointer movement.

### Frame loop
`requestAnimationFrame`, plus a 40 ms `setTimeout` fallback for throttled iframes. Pauses when off-screen (IntersectionObserver) or when the tab is hidden.

---

## 5. Mood table

Every mood starts from BASE and overrides the listed keys.

**BASE**
```
R 0.30   squash 0.86   amp 0.34   lob 0.07   lobes 3   twist 1   W 0.12
spin 0.25   yawSp 0.22   yaw0 0   pitch 0.55   roll 0.30
ripple 0   rf 6   bright 0.85   bend 0   bounce 0   sink 0   shake 0   talk 0
sphere 0.55   scale 1   lean 0
```

| Mood | Overrides | Reads as |
|---|---|---|
| resting | — | Slow turn, one half-twist, soft breathing |
| listening | pitch .12, amp .12, ripple .07, W .09, bright 1.25, yawSp .06, sphere .9, lob .04 | Turns to face you, flattens, ripples like a voice wave |
| thinking | twist 3, yawSp 1.7, spin 2.6, R .25, amp .55, lobes 2, lob .14, bright 1.15, W .1, sphere .7 | Tightens into three twists and spins fast |
| answering | R .32, W .14, bright 1.35, yawSp .35, talk 1, pitch .35, sphere .8 | Wider band that pulses with speech |
| happy | bend .95, pitch .08, roll 0, W .13, bright 1.35, bounce 1, yawSp 0, amp .12, yaw0 0, R .31, sphere .8 | Bends into a smile, bounces |
| curious | roll .55, pitch .25, yaw0 .6, yawSp .05, lob .12, bright 1.1, scale 1.04, lean 1 | Head tilt, leans toward the pointer |
| unsure | shake 1, amp .5, lob .18, lobes 5, bright .8, twist 2, yawSp 0, W .1 | Uneven shape, shakes side to side |
| sorry | bend −.9, pitch .1, scale .84, sink 1, bright .5, yawSp .05, amp .12, sphere .3, roll 0, yaw0 0 | Frowns, shrinks, sinks, dims |
| excited | scale 1.12, yawSp 1.1, ripple .05, rf 9, bright 1.7, bounce 1.6, twist 2, sphere 1 | Bigger, fast spin, ripples, brightest |

Parameter glossary: `R` loop radius · `squash` vertical squash · `amp` out-of-plane wave · `lob`/`lobes` radial wobble amount/count · `twist` half-twists around the loop · `W` ribbon half-width · `spin` twist rotation rate (rad/s) · `yawSp` turn rate (rad/s) · `yaw0`/`pitch`/`roll` pose (rad) · `ripple`/`rf` voice ripple amount/frequency · `bright` light multiplier · `bend` smile/frown · `bounce` hop · `sink` drop · `shake` head-shake · `talk` speech pulse · `sphere` shell visibility · `scale` overall size · `lean` lean toward pointer.

---

## 6. Accessibility
- The host has `role="img"` and `aria-label` set per mood (for example "Athena is thinking").
- A visually hidden `role="status"` live region announces `thinking`, `answering` and `sorry` unless `silent` is set. If your chat already announces these, set `silent`.
- `prefers-reduced-motion: reduce`: no turning, spinning, breathing, bouncing, shaking or talking. Moods still change shape (ease included), so emotion is still conveyed through form and brightness.
- Never rely on the ribbon alone for errors. Pair `sorry` with a text message.

## 7. Performance
- About 36 strands × 15 chunks = 540 strokes per frame at hero size, and 90 at chat size. Fine for several on screen.
- For long lists of messages, use `still` (or the PNGs) for old messages and animate only the latest.
- Hidden or off-screen instances stop drawing.

## 8. Static assets
- `assets/png/{512,256,128,64,32}/athena-ribbon-{mood}.png`: transparent background, settled pose.
- `assets/png/on-dark/athena-ribbon-{mood}.png`: 512 px on `#0b0d10`.
- `assets/contact-sheet.png`: all nine moods.

Use PNGs for favicons, app icons, email and anywhere script can't run. To regenerate, render `<athena-ribbon still size=N mood=M>`, then composite the main canvas with a blurred copy of itself.

## 9. Porting notes (non-web)
The math in section 3 is platform-neutral. For native (Swift/Kotlin) or WebGL:
- Draw strands as additive line strips (`.plusLighter` / `GL_ONE, GL_ONE`).
- Glow = one Gaussian blur pass of the ribbon layer, screen-blended on top.
- Keep the mood table and the 380 ms ease identical so platforms match.
