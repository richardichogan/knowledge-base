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
  for (const run of runs ?? [{ text, styles: [] }]) {
    for (const part of run.text.split(/(\n+)/)) {
      if (!part) continue;
      if (part.startsWith('\n')) {
        fragment.appendChild(document.createTextNode(part));
        passage = null;
      } else {
        if (!passage) {
          passage = document.createElement('span');
          passage.className = 'script-passage';
          passages.push(passage);
          fragment.appendChild(passage);
        }
        const span = document.createElement('span');
        span.textContent = part;
        for (const style of run.styles) span.classList.add(`script-${style}`);
        passage.appendChild(span);
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
  window.athenaOutput.report({ sessionId: state.sessionId, progress, ended: false, ack: update.sequence });
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
      window.athenaOutput.report({ sessionId: state.sessionId, progress: state.progress, ended });
      lastReport = time;
    }
  }
  last = time;
  highlightPassage();
  requestAnimationFrame(frame);
}
new ResizeObserver(measurePassages).observe(script);
requestAnimationFrame(frame);
