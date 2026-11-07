const directions = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const opposite = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };
const GAP = 14;
const CORNER = 32;
const ARROW = 20;
const AREA = { left: 40, right: 1560, top: 230, bottom: 820 };
const centre = rect => [rect.x + rect.width / 2, rect.y + rect.height / 2];
const round = value => Math.round(value * 10) / 10;
const point = ([x, y]) => `${round(x)} ${round(y)}`;

function sideRect(node, side) {
  const anchor = node.anchor ?? node.bounds;
  // A top port only uses the anchor when nothing (such as a kicker) sits above it.
  return side === 'bottom' || side === 'top' && anchor.y > node.bounds.y + 1 ? node.bounds : anchor;
}

function portPoint(node, side, along) {
  const rect = sideRect(node, side);
  const [x, y] = centre(rect);
  if (side === 'left' || side === 'right') return [side === 'left' ? rect.x - GAP : rect.x + rect.width + GAP, along ?? y];
  return [along ?? x, side === 'top' ? rect.y - GAP : rect.y + rect.height + GAP];
}

function simplify(points) {
  const result = [];
  for (const next of points) {
    const last = result.at(-1);
    if (last && Math.abs(last[0] - next[0]) < 0.5 && Math.abs(last[1] - next[1]) < 0.5) continue;
    const before = result.at(-2);
    if (before && last && (Math.abs(before[0] - last[0]) < 0.5 && Math.abs(last[0] - next[0]) < 0.5
      || Math.abs(before[1] - last[1]) < 0.5 && Math.abs(last[1] - next[1]) < 0.5)) result.pop();
    result.push(next);
  }
  return result;
}

/** Orthogonal polyline with true circular corners; never a free-form curve. */
function roundedPath(points) {
  let d = `M${point(points[0])}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1], corner = points[index], next = points[index + 1];
    const before = Math.hypot(corner[0] - previous[0], corner[1] - previous[1]);
    const after = Math.hypot(next[0] - corner[0], next[1] - corner[1]);
    const radius = Math.min(CORNER, before / 2, after / 2);
    const a = [corner[0] + (previous[0] - corner[0]) / before * radius, corner[1] + (previous[1] - corner[1]) / before * radius];
    const b = [corner[0] + (next[0] - corner[0]) / after * radius, corner[1] + (next[1] - corner[1]) / after * radius];
    const clockwise = (corner[0] - previous[0]) * (next[1] - corner[1]) - (corner[1] - previous[1]) * (next[0] - corner[0]) > 0;
    d += `L${point(a)}A${round(radius)} ${round(radius)} 0 0 ${clockwise ? 1 : 0} ${point(b)}`;
  }
  return `${d}L${point(points.at(-1))}`;
}

function sample(points) {
  const samples = [];
  for (let index = 1; index < points.length; index++) {
    const [a, b] = [points[index - 1], points[index]];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 12));
    for (let step = 1; step <= steps; step++) samples.push([a[0] + (b[0] - a[0]) * step / steps, a[1] + (b[1] - a[1]) * step / steps]);
  }
  return samples;
}

function routes(from, to, fromPort, toPort, shared, siblings) {
  const u = directions[fromPort];
  const horizontal = u[1] === 0;
  const start = portPoint(from, fromPort), end = portPoint(to, toPort);
  if (fromPort === opposite[toPort]) {
    const result = [];
    const axis = horizontal ? 1 : 0;
    const a = sideRect(from, fromPort), b = sideRect(to, toPort);
    const low = Math.max(axis ? a.y : a.x, axis ? b.y : b.x) + 12;
    const high = Math.min(axis ? a.y + a.height : a.x + a.width, axis ? b.y + b.height : b.x + b.width) - 12;
    if (high >= low) {
      // A fan-out or fan-in keeps every connection on the shared subject's centre, so a straight member never doubles the trunk.
      const guide = shared === 'from' ? a : shared === 'to' ? b : (axis ? a.height <= b.height : a.width <= b.width) ? a : b;
      const along = Math.min(high, Math.max(low, centre(guide)[axis]));
      // A fan branch may only run straight on that exact centre line; clamping it into the target's band would leave the junction off-centre.
      if (!shared || Math.abs(along - centre(guide)[axis]) < 0.5) result.push([portPoint(from, fromPort, along), portPoint(to, toPort, along)]);
    }
    const index = horizontal ? 0 : 1;
    let middle = (start[index] + end[index]) / 2;
    if (shared && siblings?.length) {
      // Every branch of a fan turns on one trunk, midway across the narrowest gap, so sibling elbows never double it.
      const port = shared === 'from' ? fromPort : toPort, sign = directions[port][index];
      const origin = portPoint(shared === 'from' ? from : to, port)[index];
      const reach = Math.min(...siblings.map(node => (portPoint(node, opposite[port])[index] - origin) * sign).filter(distance => distance > 0));
      if (Number.isFinite(reach) && reach <= Math.abs(end[index] - start[index])) middle = origin + sign * reach / 2;
    }
    result.push(horizontal ? [start, [middle, start[1]], [middle, end[1]], end] : [start, [start[0], middle], [end[0], middle], end]);
    return result;
  }
  if (fromPort === toPort) {
    const reach = 56;
    if (horizontal) {
      const x = u[0] > 0 ? Math.max(start[0], end[0]) + reach : Math.min(start[0], end[0]) - reach;
      return [[start, [x, start[1]], [x, end[1]], end]];
    }
    const y = u[1] > 0 ? Math.max(start[1], end[1]) + reach : Math.min(start[1], end[1]) - reach;
    return [[start, [start[0], y], [end[0], y], end]];
  }
  return [[start, horizontal ? [end[0], start[1]] : [start[0], end[1]], end]];
}

function score(points, from, to, fromPort, toPort, nodes, preferred, shared) {
  let total = 0;
  const u = directions[fromPort], v = directions[toPort];
  const first = [points[1][0] - points[0][0], points[1][1] - points[0][1]];
  const last = [points.at(-1)[0] - points.at(-2)[0], points.at(-1)[1] - points.at(-2)[1]];
  const firstLength = Math.hypot(...first), lastLength = Math.hypot(...last);
  if ((first[0] * u[0] + first[1] * u[1]) / (firstLength || 1) < 0.99) total += 10000;
  if ((last[0] * -v[0] + last[1] * -v[1]) / (lastLength || 1) < 0.99) total += 10000;
  if (lastLength < 40) total += 600;
  for (let index = 1; index < points.length; index++) total += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  total += (points.length - 2) * 140;
  const samples = sample(points);
  for (const [x, y] of samples) {
    if (x < AREA.left || x > AREA.right || y < AREA.top || y > AREA.bottom) total += 10000;
    for (const node of nodes) {
      const padding = node.id === from.id || node.id === to.id ? 0 : 16;
      for (const rect of node.obstacles ?? [node.bounds]) {
        if (x > rect.x - padding && x < rect.x + rect.width + padding && y > rect.y - padding && y < rect.y + rect.height + padding) total += 10000;
      }
    }
  }
  // Fan members must mirror each other on the preferred ports, so a shorter lone shortcut never breaks the fork's symmetry.
  const drift = shared ? 2000 : 80;
  if (preferred && fromPort !== preferred) total += drift;
  if (preferred && toPort !== opposite[preferred]) total += drift;
  return { total, samples };
}

function labelFor(points, shared) {
  // Branch labels sit on the part of the path unique to that branch, clear of the shared trunk and junction.
  let longest = 1, length = 0, t = 0.5;
  if (shared === 'from') { longest = points.length - 1; if (points.length === 2) t = 0.75; }
  else if (shared === 'to') { longest = 1; if (points.length === 2) t = 0.25; }
  else for (let index = 1; index < points.length; index++) {
    const span = Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
    if (span > length) { length = span; longest = index; }
  }
  const a = points[longest - 1], b = points[longest];
  const vertical = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
  const middle = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { x: middle[0] + (vertical ? 22 : 0), y: middle[1] + (vertical ? 9 : -22), anchor: vertical ? 'start' : 'middle' };
}

/** Lifecycles share one ellipse through their stage centres, so every arc segment is part of the same true curve. */
export function connectionRing(links, nodes) {
  const arcs = links.filter(link => link.route === 'arc');
  const ids = new Set(arcs.flatMap(link => [link.from, link.to]));
  if (arcs.length < 3 || ids.size < 3) return null;
  const members = nodes.filter(node => ids.has(node.id));
  const centres = members.map(node => centre(node.anchor ?? node.bounds));
  const cx = centres.reduce((sum, value) => sum + value[0], 0) / centres.length;
  const cy = centres.reduce((sum, value) => sum + value[1], 0) / centres.length;
  const rx = Math.max(...centres.map(value => Math.abs(value[0] - cx)));
  const ry = Math.max(...centres.map(value => Math.abs(value[1] - cy)));
  if (rx < 80 || ry < 80) return null;
  const angles = new Map(members.map((node, index) => [node.id, Math.atan2((centres[index][1] - cy) / ry, (centres[index][0] - cx) / rx)]));
  const first = arcs.find(link => angles.has(link.from) && angles.has(link.to));
  let turn = first ? angles.get(first.to) - angles.get(first.from) : 1;
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn <= -Math.PI) turn += 2 * Math.PI;
  return { cx, cy, rx, ry, angles, clockwise: turn >= 0,
    path: `M${point([cx, cy - ry])}A${round(rx)} ${round(ry)} 0 1 1 ${point([cx, cy + ry])}A${round(rx)} ${round(ry)} 0 1 1 ${point([cx, cy - ry])}` };
}

function ringArc(from, to, ring) {
  const at = angle => [ring.cx + ring.rx * Math.cos(angle), ring.cy + ring.ry * Math.sin(angle)];
  const inside = (node, [x, y]) => (node.obstacles ?? [node.bounds]).some(rect =>
    x > rect.x - 20 && x < rect.x + rect.width + 20 && y > rect.y - 20 && y < rect.y + rect.height + 20);
  let start = ring.angles.get(from.id), end = ring.angles.get(to.id);
  if (start === undefined || end === undefined) return null;
  let turn = end - start;
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn <= -Math.PI) turn += 2 * Math.PI;
  end = start + turn;
  const step = Math.sign(turn) * 0.004;
  while (Math.abs(end - start) > 0.1 && inside(from, at(start))) start += step;
  while (Math.abs(end - start) > 0.1 && inside(to, at(end))) end -= step;
  if (Math.abs(end - start) <= 0.1) return null;
  const tip = at(end);
  while (Math.abs(end - start) > 0.1 && Math.hypot(at(end)[0] - tip[0], at(end)[1] - tip[1]) < ARROW) end -= step;
  const samples = Array.from({ length: 33 }, (_, index) => at(start + (end - start) * index / 32));
  const middle = (start + end) / 2;
  const label = at(middle);
  const outward = [Math.cos(middle), Math.sin(middle)];
  return {
    path: `M${point(at(start))}A${round(ring.rx)} ${round(ring.ry)} 0 ${Math.abs(end - start) > Math.PI ? 1 : 0} ${end > start ? 1 : 0} ${point(at(end))}`,
    start: at(start), end: at(end), tip, samples, route: 'ring',
    label: { x: label[0] + outward[0] * 30, y: label[1] + outward[1] * 30 + 9,
      anchor: Math.abs(outward[0]) < 0.35 ? 'middle' : outward[0] > 0 ? 'start' : 'end' },
  };
}

export function connectionGeometry(from, to, link, nodes, ring = null, shared = null, siblings = []) {
  if (link.route === 'arc' && ring) {
    const arc = ringArc(from, to, ring);
    if (arc) return { ...arc, fromPort: link.fromPort ?? 'right', toPort: link.toPort ?? 'left' };
  }
  const a = centre(from.anchor ?? from.bounds), b = centre(to.anchor ?? to.bounds);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const preferred = link.fromPort || link.toPort ? null
    : Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
  let best = null;
  for (const fromPort of link.fromPort ? [link.fromPort] : Object.keys(directions)) {
    for (const toPort of link.toPort ? [link.toPort] : Object.keys(directions)) {
      for (const candidate of routes(from, to, fromPort, toPort, shared, siblings)) {
        const points = simplify(candidate);
        if (points.length < 2) continue;
        const { total, samples } = score(points, from, to, fromPort, toPort, nodes, preferred, shared);
        if (!best || total < best.total) best = { points, total, samples, fromPort, toPort };
      }
    }
  }
  if (!best) throw new Error('The visual connection has no valid endpoints.');
  const tip = best.points.at(-1), before = best.points.at(-2);
  const span = Math.hypot(tip[0] - before[0], tip[1] - before[1]);
  const pullback = Math.min(ARROW, Math.max(0, span - 12));
  best.points[best.points.length - 1] = [tip[0] - (tip[0] - before[0]) / span * pullback, tip[1] - (tip[1] - before[1]) / span * pullback];
  return {
    path: best.points.length === 2 ? `M${point(best.points[0])}L${point(best.points[1])}` : roundedPath(best.points),
    start: best.points[0], end: best.points.at(-1), tip, samples: best.samples, route: best.points.length === 2 ? 'straight' : 'elbow',
    fromPort: best.fromPort, toPort: best.toPort, label: labelFor(best.points, shared),
  };
}
