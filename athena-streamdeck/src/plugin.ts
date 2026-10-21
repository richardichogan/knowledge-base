import streamDeck, { SingletonAction, type KeyDownEvent, type WillAppearEvent, type WillDisappearEvent } from '@elgato/streamdeck';
import { COMMANDS, ELGATO_PORT, type DesktopCommand, type DesktopCommandState } from '../../athena-desktop/src/elgatoProtocol.js';

const prefix = 'com.themicrosoftcloudblog.athena';
let token = '';
let latest: DesktopCommandState | null = null;
let failure = 'Pair in Athena';
let timer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
const visible = new Map<string, { key: KeyDownEvent['action']; command: DesktopCommand }>();
const pending = new Set<string>();
const labels: Record<DesktopCommand, string> = {
  'open-athena': 'Athena', 'new-note': 'New note', 'new-diagram': 'New diagram', speak: 'Speak',
  'present-note': 'Present', play: 'Play', pause: 'Pause', 'toggle-play': 'Play / Pause',
  stop: 'Stop', faster: 'Faster', slower: 'Slower', 'text-larger': 'Text +', 'text-smaller': 'Text -',
};
async function request(path: string, command?: DesktopCommand): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Pair in Athena');
  const response = await fetch(`http://127.0.0.1:${ELGATO_PORT}${path}`, {
    method: command ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    ...(command ? { body: JSON.stringify({ id: crypto.randomUUID(), command, issuedAt: Date.now() }) } : {}),
    signal: AbortSignal.timeout(command ? 65_000 : 2000),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value ? String(value.error) : 'Desktop command failed.';
    throw new Error(message);
  }
  return value;
}
function isState(value: unknown): value is DesktopCommandState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<DesktopCommandState>;
  return v.protocol === 1 && !!v.presentation && typeof v.presentation.speed === 'number'
    && typeof v.presentation.status === 'string' && typeof v.recording === 'boolean' && typeof v.transcribing === 'boolean';
}
async function updateKeys(): Promise<void> {
  for (const { key, command } of visible.values()) {
    let detail = latest ? '' : 'Offline';
    if (latest) {
      if (command === 'faster' || command === 'slower') detail = `${latest.presentation.speed} px/s`;
      else if (command === 'text-larger' || command === 'text-smaller') detail = `${latest.presentation.fontSize} px`;
      else if (command === 'speak') detail = latest.transcribing ? 'Working' : latest.recording ? 'Recording' : 'Ready';
      else if (['play', 'pause', 'toggle-play', 'stop'].includes(command)) detail = latest.presentation.status;
    }
    await key.setTitle(`${labels[command]}\n${pending.has(key.id) ? 'Working' : detail}`);
    const active = latest && (command === 'speak' ? latest.recording
      : ['play', 'toggle-play', 'stop'].includes(command) && latest.presentation.status === 'playing');
    await key.setImage(`imgs/${command}${active ? '-active' : ''}.svg`);
  }
}
async function poll(): Promise<void> {
  if (polling || !visible.size) return;
  polling = true;
  clearTimeout(timer);
  try {
    const value = await request('/state');
    if (!isState(value)) throw new Error('Update Athena Desktop');
    latest = value; failure = '';
  } catch (error) {
    latest = null;
    failure = error instanceof Error && error.message !== 'fetch failed' ? error.message : 'Open Athena Desktop';
  }
  try {
    await updateKeys();
    if (streamDeck.ui.action) await streamDeck.ui.sendToPropertyInspector({ status: failure || latest?.error || 'Connected to Athena Desktop' });
  } catch (error) { streamDeck.logger.error('Could not update Stream Deck controls', error); }
  finally {
    polling = false;
    if (visible.size) timer = setTimeout(() => { void poll(); }, latest ? 1000 : 3000);
  }
}
class AthenaAction extends SingletonAction {
  override readonly manifestId: string;
  constructor(private readonly command: DesktopCommand) { super(); this.manifestId = `${prefix}.${command}`; }
  override onWillAppear(event: WillAppearEvent): void {
    if (!event.action.isKey()) return;
    visible.set(event.action.id, { key: event.action, command: this.command });
    void poll();
  }
  override onWillDisappear(event: WillDisappearEvent): void {
    visible.delete(event.action.id);
    if (!visible.size) clearTimeout(timer);
  }
  override async onKeyDown(event: KeyDownEvent): Promise<void> {
    if (pending.has(event.action.id)) return;
    pending.add(event.action.id);
    try {
      await updateKeys();
      // Never enqueue or replay a press when Desktop is unavailable.
      await request('/command', this.command);
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Desktop command failed.';
      await event.action.showAlert();
      if (streamDeck.ui.action) await streamDeck.ui.sendToPropertyInspector({ status: failure });
      streamDeck.logger.warn(`Athena action failed: ${failure}`);
    } finally {
      pending.delete(event.action.id);
      void poll();
    }
  }
}
for (const command of COMMANDS) streamDeck.actions.registerAction(new AthenaAction(command));
streamDeck.ui.onSendToPlugin(async event => {
  const value = event.payload;
  if (!value || typeof value !== 'object' || !('token' in value) || typeof value.token !== 'string') return;
  if (!/^[a-f0-9]{64}$/.test(value.token)) {
    await streamDeck.ui.sendToPropertyInspector({ status: 'Paste the full pairing key copied from Athena.' });
    return;
  }
  token = value.token;
  await streamDeck.settings.setGlobalSettings({ token });
  await streamDeck.ui.sendToPropertyInspector({ status: 'Pairing saved. Testing connection...' });
  void poll();
});
streamDeck.ui.onDidAppear(async () => {
  await streamDeck.ui.sendToPropertyInspector({ status: failure || latest?.error || 'Connected to Athena Desktop' });
});
await streamDeck.connect();
const saved = await streamDeck.settings.getGlobalSettings<{ token?: string }>();
token = saved.token ?? '';
void poll();
