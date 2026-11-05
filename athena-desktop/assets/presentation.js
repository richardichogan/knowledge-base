/* The output has no network, note API or general desktop capabilities. */
const viewport = document.getElementById('viewport');
const script = document.getElementById('script');
let state = null;
let last = null;
let lastReport = 0;
let offset = 0;
let passages = [];
let passageTops = [];
let currentPassage = null;
let scriptLength = 0;
function readingPosition() {
  if (!currentPassage) return 0;
  const nodes = [];
  const walker = document.createTreeWalker(currentPassage, NodeFilter.SHOW_TEXT);
  let node;
  let length = 0;
  while ((node = walker.nextNode())) { nodes.push({ node, start: length }); length += node.length; }
  const guide = viewport.scrollTop + viewport.clientHeight * (state?.flip ? 0.65 : 0.35);
  const viewportRect = viewport.getBoundingClientRect();
  let low = 0, high = length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const entry = [...nodes].reverse().find(entry => entry.start <= middle);
    if (!entry) break;
    const range = document.createRange();
    range.setStart(entry.node, middle - entry.start);
    range.setEnd(entry.node, middle - entry.start + 1);
    const rect = range.getBoundingClientRect();
    const top = viewport.scrollTop + (state?.flip ? viewportRect.bottom - rect.bottom : rect.top - viewportRect.top);
    if (top <= guide + 1) low = middle + 1;
    else high = middle;
  }
  return Math.min(scriptLength, Number(currentPassage.dataset.start) + Math.max(0, low - 1));
}
function report(extra = {}) {
  if (!state) return;
  highlightPassage();
  window.athenaOutput.report({ sessionId: state.sessionId, progress: viewport.scrollTop / Math.max(1, viewport.scrollHeight - viewport.clientHeight),
    position: readingPosition(), ended: false, ...extra });
}
function measurePassages() {
  passageTops = passages.map(passage => passage.offsetTop);
}
function highlightPassage() {
  if (!passages.length) return;
  const guide = viewport.scrollTop + viewport.clientHeight * (state?.flip ? 0.65 : 0.35);
  let low = 0, high = passageTops.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (passageTops[middle] <= guide) low = middle + 1;
    else high = middle;
  }
  const next = passages[Math.max(0, low - 1)];
  if (next === currentPassage) return;
  currentPassage?.classList.remove('script-passage--current');
  next.classList.add('script-passage--current');
  currentPassage = next;
}
function renderScript(text, runs) {
  const fragment = document.createDocumentFragment();
  let passage = null;
  passages = [];
  currentPassage = null;
  let character = 0;
  scriptLength = text.length;
  for (const run of runs ?? [{ text, styles: [] }]) {
    for (const part of run.text.split(/(\n+)/)) {
      if (!part) continue;
      if (part.startsWith('\n')) {
        fragment.appendChild(document.createTextNode(part));
        character += part.length;
        passage = null;
      } else {
        if (!passage) {
          passage = document.createElement('span');
          passage.className = 'script-passage';
          passage.dataset.start = String(character);
          passages.push(passage);
          fragment.appendChild(passage);
        }
        const span = document.createElement('span');
        span.textContent = part;
        for (const style of run.styles) span.classList.add(`script-${style}`);
        passage.appendChild(span);
        character += part.length;
      }
    }
  }
  script.replaceChildren(fragment);
}
window.athenaOutput.onUpdate(update => {
  const same = state && state.sessionId === update.state.sessionId;
  const progress = same && !update.reset
    ? viewport.scrollTop / Math.max(1, viewport.scrollHeight - viewport.clientHeight)
    : update.state.progress;
  if (update.text !== undefined) {
    renderScript(update.text, update.runs);
  }
  state = update.state;
  script.style.fontSize = `${state.fontSize}px`;
  document.body.classList.toggle('mirror', state.mirror);
  document.body.classList.toggle('flip', state.flip);
  viewport.scrollTop = progress * Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  offset = viewport.scrollTop;
  measurePassages();
  highlightPassage();
  report({ ack: update.sequence });
  last = null;
});
function frame(time) {
  if (state && state.status === 'playing') {
    const elapsed = last === null ? 0 : Math.min(0.1, (time - last) / 1000);
    const max = viewport.scrollHeight - viewport.clientHeight;
    offset = Math.min(max, offset + state.speed * elapsed);
    viewport.scrollTop = offset;
    const ended = max <= 0 || viewport.scrollTop >= max - 1;
    state.progress = max > 0 ? viewport.scrollTop / max : 1;
    if (ended) state.status = 'ended';
    if (ended || time - lastReport > 200) {
      report({ ended });
      lastReport = time;
    }
  }
  last = time;
  highlightPassage();
  requestAnimationFrame(frame);
}
viewport.addEventListener('scroll', () => {
  if (state?.status !== 'playing' || Math.abs(viewport.scrollTop - offset) > 2) offset = viewport.scrollTop;
  if (state?.status !== 'playing') report();
});
viewport.addEventListener('wheel', event => {
  event.preventDefault();
  const scale = event.deltaMode === 1 ? state?.fontSize ?? 64 : event.deltaMode === 2 ? viewport.clientHeight : 1;
  viewport.scrollTop += event.deltaY * scale;
  offset = viewport.scrollTop;
  report();
}, { passive: false });
new ResizeObserver(() => { measurePassages(); report(); }).observe(script);
requestAnimationFrame(frame);
