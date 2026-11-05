export function createPresenterVideo(host, { capture = false, report = () => {} } = {}) {
  const document = host.ownerDocument;
  const slot = document.createElement('aside');
  slot.className = 'presenter-video';
  slot.setAttribute('aria-label', 'Presenter video');
  slot.hidden = true;
  const guide = document.createElement('span');
  guide.className = 'presenter-video__guide';
  guide.textContent = 'Video feed · 16:9';
  const video = document.createElement('video');
  video.className = 'presenter-video__feed';
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('aria-label', 'Live presenter camera');
  const message = document.createElement('p');
  message.className = 'presenter-video__message';
  message.setAttribute('role', 'status');
  slot.append(guide, video, message);
  host.append(slot);
  let stream = null;
  let generation = 0;
  let attempt = '';
  let current = null;
  let disposed = false;
  function release() {
    generation++;
    video.pause();
    video.srcObject = null;
    stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    stream = null;
    slot.classList.remove('presenter-video--live');
  }
  function state(status, error = null) {
    slot.classList.toggle('presenter-video--error', status === 'error');
    message.textContent = error || (status === 'requesting' ? 'Allow camera access in this browser…' : '');
    message.hidden = !message.textContent;
    if (current) report({ ...current, status, error });
  }
  function failed(error) {
    release();
    const reason = error?.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow it in this browser, then retry Camera from the script toolbar.'
      : error?.name === 'NotFoundError'
        ? 'No camera was found. Connect a camera, then retry from the script toolbar.'
        : error?.name === 'NotReadableError'
          ? 'The camera is unavailable or in use by another app. Release it in Teams/Riverside, retry, or select Off.'
          : `Camera could not start: ${error instanceof Error ? error.message : 'unknown camera error'}. Retry from the script toolbar or select Off.`;
    state('error', reason);
  }
  async function start() {
    const ownGeneration = ++generation;
    state('requesting');
    let acquired = null;
    try {
      if (!document.defaultView?.navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser');
      acquired = await document.defaultView.navigator.mediaDevices.getUserMedia({
        audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16 / 9 } },
      });
      if (disposed || ownGeneration !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      video.srcObject = stream;
      await video.play();
      if (disposed || ownGeneration !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
      for (const track of stream.getVideoTracks()) track.onended = () => {
        release();
        state('error', 'The camera disconnected or permission was revoked. Retry Camera from the script toolbar, or select Off.');
      };
      slot.classList.add('presenter-video--live');
      state('active');
    } catch (error) {
      acquired?.getTracks().forEach(track => track.stop());
      if (!disposed && ownGeneration === generation) failed(error);
    }
  }
  return {
    update(visible, requested) {
      if (disposed) return;
      current = requested ?? { mode: 'guide', status: 'idle', error: null, requestId: '' };
      slot.hidden = !visible || current.mode === 'off';
      slot.classList.toggle('presenter-video--guide', current.mode === 'guide');
      slot.classList.toggle('presenter-video--camera', current.mode === 'camera');
      slot.classList.toggle('presenter-video--error', current.status === 'error');
      guide.hidden = current.mode !== 'guide';
      if (!visible || current.mode !== 'camera') {
        if (stream || attempt) {
          release();
          if (!visible && current.mode === 'camera') state('waiting');
        }
        attempt = '';
        message.hidden = true;
        return;
      }
      if (!capture) {
        message.textContent = current.error || (current.status === 'active' ? 'Camera live in audience output' : 'Camera in audience output');
        message.hidden = false;
        return;
      }
      if (current.status === 'error') {
        release();
        attempt = current.requestId;
        message.textContent = current.error || 'Camera unavailable. Retry from the script toolbar or select Off.';
        message.hidden = false;
        return;
      }
      if (current.requestId && attempt !== current.requestId) {
        release();
        attempt = current.requestId;
        void start();
      }
    },
    disconnect(messageText) {
      release();
      attempt = current?.requestId ?? '';
      if (!slot.hidden && current?.mode === 'camera') {
        message.textContent = messageText;
        message.hidden = false;
      }
    },
    dispose() { disposed = true; release(); slot.remove(); },
  };
}
