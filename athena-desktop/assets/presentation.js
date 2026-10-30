/* The output has no network, note API or general desktop capabilities. */
const viewport = document.getElementById('viewport');
const script = document.getElementById('script');
let state = null;
let last = null;
let lastReport = 0;
let offset = 0;
window.athenaOutput.onUpdate(update => {
  const same = state && state.sessionId === update.state.sessionId;
  const progress = same && !update.reset
    ? viewport.scrollTop / Math.max(1, viewport.scrollHeight - viewport.clientHeight)
    : update.state.progress;
  if (update.text !== undefined) {
    if (update.runs) {
      const fragment = document.createDocumentFragment();
      for (const run of update.runs) {
        const span = document.createElement('span');
        span.textContent = run.text;
        for (const style of run.styles) span.classList.add(`script-${style}`);
        fragment.appendChild(span);
      }
      script.replaceChildren(fragment);
    } else script.textContent = update.text;
  }
  state = update.state;
  script.style.fontSize = `${state.fontSize}px`;
  document.body.classList.toggle('mirror', state.mirror);
  document.body.classList.toggle('flip', state.flip);
  viewport.scrollTop = progress * Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  offset = viewport.scrollTop;
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
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
