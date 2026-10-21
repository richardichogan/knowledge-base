let socket;
let uuid;
let actionId;
window.connectElgatoStreamDeckSocket = (port, id, registerEvent, info, actionInfo) => {
  uuid = id;
  actionId = JSON.parse(actionInfo).action;
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.onopen = () => socket.send(JSON.stringify({ event: registerEvent, uuid }));
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.event === 'sendToPropertyInspector' && typeof message.payload?.status === 'string') {
      document.getElementById('status').textContent = message.payload.status;
    }
  };
  socket.onerror = () => { document.getElementById('status').textContent = 'Stream Deck connection failed. Reopen this action.'; };
};
document.getElementById('pair').addEventListener('submit', event => {
  event.preventDefault();
  const input = document.getElementById('token');
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    document.getElementById('status').textContent = 'Stream Deck is not connected. Reopen this action.';
    return;
  }
  socket.send(JSON.stringify({ action: actionId, event: 'sendToPlugin', context: uuid, payload: { token: input.value.trim() } }));
  input.value = '';
});
