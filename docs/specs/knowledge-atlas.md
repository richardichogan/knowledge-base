# Knowledge Atlas — full build spec

Repository integration: the supplied renderer is imported at
`knowledge-hub-web/public/athena/atlas-graph.js`; the supplied Athena mark was
already byte-identical to the installed asset. Physics, palette and timings
below remain unchanged. App-specific additions are instance-local commands and
seeded random state, lifecycle/visibility cleanup, live reduced-motion support,
instant reduced-motion paths, pointer cancellation/pinch handling, long-label
clamping, collision-aware label budgets (six titles in the full graph, four in
compact mode), and optional connected-context visibility. Labels prioritise
root, hover and selection; full titles and activity details live in hover
tooltips and the inspector. This supersedes the unrestricted labels and
secondary metadata described in the original handoff below. The adapter retains all
real entity kinds and evidence labels. See `../athena-spec.md` for bounded-data,
endpoint resolution and compact-panel behavior. Placeholder demo data is not
shipped.

Everything needed to reproduce the Knowledge Atlas graph, its motion and its Athena integration. The reference implementation is `src/atlas-graph.js` (framework-agnostic custom element, Canvas 2D, no dependencies). If anything here disagrees with the source, the source wins.

---

## 1. What it is

An interactive map of projects and everything attached to them (people, ideas, documents, meetings). Projects form clusters. Links between clusters are the interesting part, and Athena can trace the shortest route between any two items.

Files:

| File | Purpose |
|---|---|
| `src/atlas-graph.js` | `<atlas-graph>` element: physics, camera, rendering, input |
| `src/atlas-data.js` | Placeholder dataset → `window.ATLAS` (replace with your backend) |
| `src/athena-mark.js` | `<athena-mark>` used in the Ask Athena panel |
| `demo.html` | Standalone working page (open in a browser, no build) |

---

## 2. Data contract

```js
window.ATLAS = {
  types: {
    project: { label: 'Projects',  one: 'Project',  color: '#08bdba' },
    person:  { label: 'People',    one: 'Person',   color: '#ff7eb6' },
    idea:    { label: 'Ideas',     one: 'Idea',     color: '#be95ff' },
    doc:     { label: 'Documents', one: 'Document', color: '#78a9ff' },
    meeting: { label: 'Meetings',  one: 'Meeting',  color: '#ffb784' }
  },
  nodes: [ { id, name, type, project, hub, island, last } ],
  edges: [ { a, b, rel, kind } ],
  islandCount: 5
};
```

**Node**
- `id` string, unique.
- `name` display label.
- `type` key into `types`.
- `project` id of the owning project, or `null` for unlinked items. A project node has `project === id`.
- `hub` `true` only for project nodes.
- `island` integer group index for unlinked items (used for initial placement only).
- `last` days since last activity (integer). Drives pulses, the range filter and "quiet" warnings. A project's `last` = min of its members.

**Edge**
- `a`, `b` node ids (undirected).
- `rel` relationship label shown in the UI ("works on", "attended", "reuses"…).
- `kind` one of `member` (item → its project), `internal` (two items in the same project), `cross` (items in different projects), `island` (inside an unlinked group).

Pass data either by setting `window.ATLAS` before the element connects, or `el.data = {...}` at any time (re-initialises and refits).

---

## 3. Element API

```html
<atlas-graph selected="" path="" hide-types="" search="" range="9999" group="" scope="" depth="2" compact></atlas-graph>
```

| Attribute | Value | Effect |
|---|---|---|
| `selected` | node id | Highlights node + neighbours, camera eases to it (zoom ≥ 1.3) |
| `path` | comma-separated ids | Draws Athena's traced path, camera fits the path |
| `hide-types` | comma list (`person,doc`) | Hides those types (projects are never hidden) |
| `search` | text | Dims non-matching nodes, labels matches |
| `range` | days | Dims items with `last > range` |
| `group` | `islands` or empty | Focuses unlinked groups and fits them |
| `scope` | node id | Ego view: only nodes within `depth` hops of this id |
| `depth` | integer, default 2 | Hops for `scope` |
| `compact` | boolean | Small-panel mode (tighter margins, no project meta line) |

Events (bubble, composed):
- `atlas-select` `{ detail: { id } }` — fired on click without drag. `id` is `null` on empty canvas.

Commands (window event):
```js
window.dispatchEvent(new CustomEvent('atlas-cmd', { detail: 'in' | 'out' | 'fit' }));
```

---

## 4. Visual spec

Theme: Carbon G100. Canvas background `#161616`. System UI font stack.

### 4.1 Layers, back to front
1. **Background** `#161616`.
2. **Dot grid** — 1.5px squares `#262626` every 48 world units. Hidden when on-screen spacing < 14px.
3. **Project hulls** — convex hull of each project's visible nodes, stroked with round joins at `2 × pad` and filled, white, composited at low alpha. `pad` = 26px (16px compact) × zoom factor. Alpha: 0.045 normal, 0.075 for the focused node's project, 0.022 when anything else is focused.
4. **Edges** — quadratic curves. Control point = midpoint offset perpendicular by 10% of length.
5. **Flow particles** on edges (see motion).
6. **Athena path** (when active).
7. **Nodes** — items first, projects on top.
8. **Project labels** — centred under hub: name 600 13px `#f4f4f4`; meta line 12px `#a8a8a8` (`#ff8389` if quiet). Meta: `{n} items · active {d} days ago` or `quiet {d} days`.
9. **Node labels** — 12px `#c6c6c6`, focused/path nodes 600 13px `#f4f4f4`. All text gets a 4px `#161616` stroke halo. Labels flip to the left near the right edge and are clamped inside the canvas.

### 4.2 Edge styles

| kind | rest length | spring k | alpha | colour | dash |
|---|---|---|---|---|---|
| member | 70 | 0.10 | 0.32 | `#8d8d8d` | — |
| internal | 55 | 0.05 | 0.20 | `#8d8d8d` | — |
| cross | 190 | 0.02 | 0.75 | `#c6c6c6` | 5 5 |
| island | 38 | 0.15 | 0.35 | `#8d8d8d` | — |

Line width 1 (cross 1.2). Edges touching the focused node: width 1.6, alpha 0.85, colour = focused node's type colour. All others drop to 0.04.

### 4.3 Nodes
- Radius: project `9 + √deg × 1.1`; item `3 + √deg × 1.7` (world px), multiplied on screen by `zr = clamp(√zoom, 0.7, 1.8)` so dots grow slower than the map.
- Item: filled circle, type colour.
- Project: `#161616` fill, 2.5px ring in project colour, inner dot at 42% radius.
- Dimmed (not lit): alpha 0.14.
- Selected / hovered: ring at `r + 4`, 1.75px `#f4f4f4` (hover-only 1px).
- On path: ring `#4589ff`.
- Scope root: extra 2px `#3ddbd9` ring at `r + 5`.

### 4.4 Lit rules (what stays bright)
In priority order: outside `range` or not matching `search` → dim. Path active → only path nodes. Focus (hover overrides selection) → focus + direct neighbours. `group=islands` → unlinked only. Else everything.

---

## 5. Motion spec

All motion is driven from one `requestAnimationFrame` loop (with a 40ms `setTimeout` fallback so it keeps ticking in throttled iframes). Loop is capped at ~80fps.

### 5.1 Load sequence (0 – 3.2s)
1. **Placement (t=0)**: projects on an ellipse, radius 300 × 231 (`0.77` y-squash), evenly spaced. Items start within ±8px of their project. Unlinked groups on a wider ellipse 560 × 430 at a random angle per group. Seeded RNG (`seed = 11`, Park–Miller) so layout is identical every load.
2. **Pre-settle**: 6 physics ticks before first paint (320 with reduced motion = arrives settled).
3. **Bloom**: clusters expand outward as the simulation runs. `alpha` starts at 1 and eases to 0.04 (`alpha += (target − alpha) × 0.0228` per tick, ≈ 3s to settle).
4. **Node grow-in**: projects appear immediately. Each item waits `0.15 + (seed % 1) × 0.6` s, then grows from 40% to 100% radius over 0.5s (linear).
5. **Auto-fit**: for the first 3.2s the camera continuously refits to all visible nodes (margin 80px, 70 compact). Any pointer-down cancels it.

### 5.2 Physics (per tick)
- **Repulsion** (pairs within 800px): `f = s × alpha / d²`, where `s` = 1400 hub–hub, 50 same project, 160 hub–item, 110 otherwise. Scoped view: 120 / 40 / 60 / 45.
- **Springs**: per edge kind (table 4.2). `f = (d − L) / d × k × alpha`. Edges on the selected node use `L × 0.75` (neighbours pull in). Scoped view caps `L` at 80 and keeps root edges ≥ 70.
- **Gravity** to origin: x `0.004`, y `0.0055` × alpha (scoped: 0.01 / 0.012). The stronger y-pull gives a landscape layout.
- **Ambient drift** (forever, not scaled by alpha): `vx += sin(time × 0.5 + seed) × w`, `vy += cos(time × 0.43 + seed × 1.7) × w`, `w` = 0.012 hubs, 0.035 items. Paused while dragging and with reduced motion.
- **Damping** `v × 0.6`, then integrate.
- Dragged node is pinned to the pointer (`fx, fy`); alpha target raised to 0.3 while dragging, back to 0.04 on release.

### 5.3 Ongoing ambient motion
- **Activity pulse**: lit items with `last ≤ 3` emit a ring every 1.25s: radius `r + 2 → r + 11`, alpha `0.6 → 0`, 1.5px, type colour. Phase offset by radius so pulses don't sync.
- **Cross-project particles** (only when nothing is focused): one 1.8px `#f4f4f4` dot per cross edge travelling the curve, speed 0.18 loops/s, random phase, alpha `sin(u × π) × 0.9` (fades in and out at the ends).
- **Focus flow**: when a node is focused, each touching edge carries 2 dots (radius 2, type colour) flowing away from the focus at 0.45 loops/s, half a loop apart.

### 5.4 Camera
- Eased chase: `cam += (target − cam) × 0.14` per frame for x, y and zoom. Snaps when within 0.3px / 0.002 zoom.
- Fit: bounding box of target nodes, zoom clamped 0.3 – 2.2 (compact 0.15 – 1.6).
- Select: centre on node, zoom = `max(current, 1.3)`, physics alpha bumped to ≥ 0.12 so neighbours visibly draw in.
- Zoom buttons ×1.35 / ÷1.35, clamped 0.25 – 4. Wheel: `zoom × exp(−deltaY × 0.0015)`, anchored at the cursor.
- At zoom > 1.7 all item labels appear.

### 5.5 Athena path reveal
Triggered by setting `path`.
1. Camera fits path nodes (margin 200).
2. After 200ms, each segment draws in over 350ms, one after another (segment `i` starts at `200 + i × 350` ms). Stroke 3px `#4589ff`, round caps, 12px `#4589ff` glow.
3. When fully drawn, a 2.5px white dot loops along the whole path at 0.35 loops/s.
4. All non-path nodes dim to 0.14, edges to 0.05.
5. Side panel steps fade/slide in in sync: opacity 0 → 1 and translateY 8 → 0, 240ms, delay `200 + i × 350` ms.

Athena mark timing around a question: `thinking` immediately → `answering` at 1400ms (path + text appear) → `resting` at 3200ms.

### 5.6 Reduced motion
`prefers-reduced-motion: reduce` → layout pre-settled, no grow-in, no drift, no pulses, no particles, no auto-fit animation. Camera moves and path still work (path draws instantly).

---

## 6. Interaction

| Input | Result |
|---|---|
| Hover node | Temporary focus (overrides selection), shows label + `{Type} · active {d} days ago` |
| Click node (moved < 4px) | `atlas-select` with id → host sets `selected` |
| Click empty canvas | `atlas-select` with `null` |
| Drag node | Moves it; graph reacts live |
| Drag canvas | Pan |
| Wheel / pinch | Zoom at cursor |
| Hit target | Node radius on screen + 7px |

Cursor: `grab` on canvas, `pointer` over a node, `grabbing` while dragging.

---

## 7. Page layout (reference: `Knowledge Atlas v2.dc.html`)

- **Header** (16/24px padding, bottom border `#393939`): breadcrumb 12px `#a8a8a8`, title 24px 600, subtitle 14px `#c6c6c6`, summary `{n} entities · {n} connections · {n} projects` right-aligned.
- **Toolbar**: search input 36px high, max 320px; type chips (pill, 32px, dot + label + count; off = dimmed); "Active in" segmented control 7 / 30 / 90 days / All time.
- **Canvas** fills remaining space. Overlays: "Show everything" button top-left when anything is focused; legend bottom-left; zoom stack (+ / − / Fit, 36px buttons) bottom-right.
- **Side panel** 360px, `#1c1c1c`, left border `#393939`:
  - Selected node card: type dot + label, name 20px 600, meta (project · activity · connection count; quiet in `#ff8389`), list of connections (click to jump), buttons Open / "How does this connect to {other project}?".
  - Ask Athena: `<athena-mark size="20">`, question input + Ask. While thinking: "Tracing connections...". Answer: question echo, sentence, step list (dot + connecting line in `#4589ff`, name, relationship · type, quiet steps in `#ff8389`), Clear path.
  - "Athena noticed" insight cards (when no answer).

Radii: 4px controls, 999px chips. Accent for Athena actions `#3ddbd9` on `rgba(61,219,217,0.08)`.

---

## 8. Athena logic

**Path finding**: breadth-first search over the undirected edge list → shortest hop path. Answer copy:
- No path: "I couldn't find a link between A and B."
- Direct: "A links directly to B."
- Else: "A connects to B in {n} steps, through X, Y and Z."
- If any non-project step has `last > 14`: append "{name} hasn't been touched in {d} days, so this link may be out of date."

**Question parsing (demo)**: find node names mentioned in the text, in order. 2+ → path between the first two. 1 → path from it to the "other" hub. 0 → default example. Replace with your real NL layer.

**Insights** (computed once from data):
1. *Connector* — person spanning the most projects.
2. *Single link* — a project pair joined by exactly one cross edge → "Show the link" traces it.
3. *Going quiet* — project with `last > 14`, oldest first.
4. *Unlinked* — count of island groups/items → "Show them" sets `group=islands`.

---

## 9. Compact variant (notes panel)

`<atlas-graph compact scope="{id}" depth="2">` at 360 × 300.
- Only nodes within 2 hops of the scope id; root pinned at centre with a `#3ddbd9` ring and its label above.
- Smaller repulsion/springs (see 5.2) so it reads at small size.
- Fit margins 56 × 44, zoom 0.15 – 1.6, hull pad 16, no project meta line, labels clamped inside the box.

---

## 10. Performance notes
- Repulsion is O(n²) with a 800px cutoff; fine to ~600 nodes. Above that, swap in a Barnes–Hut quadtree (the force formula is unchanged).
- Hulls are drawn on an offscreen canvas per project, then composited — keeps the rounded-blob look cheap.
- Canvas is sized to `devicePixelRatio`. Off-screen nodes (60px margin) are skipped.

## 11. Accessibility
- Provide a parallel list view of nodes/connections for keyboard and screen-reader users (canvas content is not exposed).
- Athena answers live in normal DOM (the step list), so they are readable and focusable.
- `<athena-mark>` announces thinking/answering via its own live region.
- Respect reduced motion (5.6).

## 12. Wiring to a real backend
1. Map your entities to the node shape in section 2. `last` = days since `updated_at`.
2. Map relationships to edges and classify `kind` (same project → `internal`, different → `cross`, item→project → `member`).
3. Set `el.data = payload` (or `window.ATLAS` before load).
4. Replace demo question parsing with your search/NL service; keep `path` as the output contract.
