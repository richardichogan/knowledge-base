import { BrowserWindow, screen, type WebContents } from 'electron';
import { classifyUrl } from './navigation';
import type { PresentationDemoAction, PresentationTurnaroundRoute } from './elgatoProtocol';

const ORIGIN = 'http://localhost:5173';
const START = `${ORIGIN}/turnaround/overview`;
const PARTITION = 'persist:athena-turnaround-demo';
const ROUTES: Record<PresentationTurnaroundRoute, { path: string; view?: string }> = {
  overview: { path: '/turnaround/overview' },
  plan: { path: '/turnaround/plan' },
  scopeList: { path: '/turnaround/queue', view: 'work-orders' },
  challenge: { path: '/turnaround/challenge' },
  finalScope: { path: '/turnaround/final-scope' },
  scenarioPlanner: { path: '/turnaround/twin' },
  productionImpact: { path: '/turnaround/production-impact' },
  gate: { path: '/turnaround/gate' },
  audit: { path: '/turnaround/audit' },
};

function routeMatches(url: URL, route: { path: string; view?: string }): boolean {
  const view = url.searchParams.get('view');
  return url.pathname === route.path && (route.view === undefined || view === route.view
    || (route.path === '/turnaround/queue' && route.view === 'work-orders' && view === null));
}

async function routeReached(contents: WebContents, route: { path: string; view?: string }): Promise<boolean> {
  if (!routeMatches(new URL(contents.getURL()), route)) return false;
  if (route.path !== '/turnaround/queue' || route.view !== 'work-orders') return true;
  return contents.executeJavaScript(`(() => {
    const tab = document.querySelector('[data-demo-id="turnaround-queue-tab-work-orders"]');
    return !!tab && (tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('data-state') === 'active');
  })()`, true) as Promise<boolean>;
}

function allowed(url: string): boolean {
  const kind = classifyUrl(url, ORIGIN);
  return kind === 'athena' || kind === 'sign-in' || kind === 'blank';
}

function guard(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => allowed(url)
    ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } } }
    : { action: 'deny' });
  contents.on('did-create-window', child => guard(child.webContents));
  contents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
}

export class DemoOutput {
  private win: BrowserWindow | null = null;
  private actions: PresentationDemoAction[] = [];
  private completed = 0;
  private position = 0;
  private playing = false;
  private draining = false;
  private busy = false;
  private generation = 0;
  private displayId: number | null = null;

  constructor(private readonly failed: (message: string) => void) {}

  async open(displayId: number, prompterId: number | null, actions: PresentationDemoAction[]): Promise<void> {
    const display = screen.getAllDisplays().find(item => item.id === displayId);
    if (!display || display.id === screen.getPrimaryDisplay().id || display.id === prompterId) {
      throw new Error('Choose a demo display separate from the presenter and prompter.');
    }
    this.close();
    this.actions = actions;
    this.completed = 0;
    const win = new BrowserWindow({ ...display.bounds, frame: false, show: false, autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    this.win = win;
    this.displayId = display.id;
    guard(win.webContents);
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null; this.displayId = null; this.generation++; this.playing = false;
      this.failed('The Turnaround demo window closed. Reopen it before continuing.');
    });
    try { await win.loadURL(START); if (this.win !== win) throw new Error('Demo window was closed.'); win.show(); }
    catch (error) { if (!win.isDestroyed()) win.close(); throw error; }
  }

  close(): void {
    this.generation++;
    this.playing = false;
    this.draining = false;
    const win = this.win;
    this.win = null;
    this.displayId = null;
    if (win && !win.isDestroyed()) win.close();
  }

  displayChanged(display: Electron.Display, removed: boolean, prompterId: number | null): void {
    if (!this.win || display.id !== this.displayId) return;
    if (removed || display.id === screen.getPrimaryDisplay().id || display.id === prompterId) {
      this.close();
      this.failed('The demo display changed or disconnected. Choose a separate display and reopen the demo.');
    } else this.win.setBounds(display.bounds);
  }

  update(position: number, playing: boolean, ended = false): void {
    this.position = position;
    this.draining = ended && (this.playing || this.draining);
    this.playing = playing || this.draining;
    if (this.playing && this.win && !this.busy && this.actions[this.completed]?.at !== undefined
      && this.actions[this.completed]!.at <= position) void this.run();
  }

  private async run(): Promise<void> {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const generation = this.generation;
    this.busy = true;
    try {
      while (this.playing && this.win === win && generation === this.generation) {
        const action = this.actions[this.completed];
        if (!action || action.at > this.position) break;
        const deadline = Date.now() + 10_000;
        let target: { x: number; y: number } | null = null;
        const route = action.action === 'navigate' ? ROUTES[action.route] : null;
        if (route) {
          const current = new URL(win.webContents.getURL());
          if (current.origin !== ORIGIN || !current.pathname.startsWith('/turnaround/')) {
            throw new Error('The demo is not on an approved Turnaround screen. Sign in and reopen the demo.');
          }
          if (await routeReached(win.webContents, route)) { this.completed++; continue; }
        }
        while (!target && Date.now() < deadline && this.playing && this.win === win && generation === this.generation) {
          const current = new URL(win.webContents.getURL());
          if (current.origin !== ORIGIN || (route
            ? !current.pathname.startsWith('/turnaround/')
            : !['/turnaround/overview', '/turnaround/queue'].includes(current.pathname))) {
            throw new Error('The demo is not on the expected Turnaround page. Sign in and reopen the demo.');
          }
          if (!route && action.action !== 'scope-list' && current.pathname === '/turnaround/overview') {
            await new Promise(resolve => setTimeout(resolve, 200));
            continue;
          }
          if (!route && action.action === 'scope-list' && current.pathname !== '/turnaround/overview') throw new Error('The demo has left Overview. Reopen it before starting.');
          const code = `(() => {
            const action = ${JSON.stringify(action.action)};
            const route = ${JSON.stringify(route)};
            const candidates = action === 'navigate' ? [...document.querySelectorAll('a[href]')].filter(a => {
                const url = new URL(a.href, location.href);
                const view = url.searchParams.get('view');
                return url.origin === location.origin && url.pathname === route.path
                  && (!route.view || view === route.view || (route.path === '/turnaround/queue' && route.view === 'work-orders' && view === null));
              })
              : action === 'scope-list' ? [...document.querySelectorAll('a[href]')].filter(a => new URL(a.href, location.href).origin === location.origin && new URL(a.href, location.href).pathname === '/turnaround/queue')
              : action === 'jobs' ? [...document.querySelectorAll('[data-demo-id="turnaround-queue-tab-jobs"]')]
              : (() => { const tab = document.querySelector('[data-demo-id="turnaround-queue-tab-jobs"]');
                  if (!tab || (tab.getAttribute('aria-selected') !== 'true' && tab.getAttribute('data-state') !== 'active')) return [];
                  return [...document.querySelectorAll('a[href]')].filter(a => new URL(a.href, location.href).origin === location.origin && new URL(a.href, location.href).pathname.startsWith('/turnaround/items/')); })();
            let point = null;
            for (const el of candidates) {
              const before = el.getBoundingClientRect();
              if (!before.width || !before.height) continue;
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              const r = el.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
              const hit = document.elementFromPoint(x, y);
              if (hit && (el === hit || el.contains(hit))) { point = { x, y }; break; }
            }
            if (!point) return null;
            const { x, y } = point;
            let cursor = document.getElementById('athena-demo-cursor');
            if (!cursor) { cursor = document.createElement('div'); cursor.id = 'athena-demo-cursor';
              Object.assign(cursor.style, { position:'fixed', zIndex:'2147483647', pointerEvents:'none', width:'18px', height:'18px', border:'3px solid white', borderRadius:'50%', background:'#0f62fe', boxShadow:'0 0 0 3px #161616', transition:'left 500ms ease, top 500ms ease', left:'24px', top:'24px' });
              document.body.appendChild(cursor); }
            requestAnimationFrame(() => { cursor.style.left = (x - 9) + 'px'; cursor.style.top = (y - 9) + 'px'; });
            return { x, y };
          })()`;
          target = await win.webContents.executeJavaScript(code, true) as { x: number; y: number } | null;
          if (!target) await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!this.playing || this.win !== win || generation !== this.generation) break;
        if (!target) throw new Error(`Could not find the ${action.action} target. The demo has stopped.`);
        await new Promise(resolve => setTimeout(resolve, 550));
        if (!this.playing || this.win !== win || generation !== this.generation) break;
        const url = new URL(win.webContents.getURL());
        if (url.origin !== ORIGIN || (!route && (action.action === 'scope-list'
          ? url.pathname !== '/turnaround/overview' : url.pathname !== '/turnaround/queue'))) throw new Error('The demo page changed before the click.');
        const valid = await win.webContents.executeJavaScript(`(() => {
          const hit = document.elementFromPoint(${target.x}, ${target.y});
          if (!hit) return false;
          const action = ${JSON.stringify(action.action)};
          const route = ${JSON.stringify(route)};
          if (action === 'navigate') {
            const link = hit.closest('a[href]'); if (!link || !route) return false;
            const url = new URL(link.href, location.href);
            const view = url.searchParams.get('view');
            return url.origin === location.origin && url.pathname === route.path
              && (!route.view || view === route.view || (route.path === '/turnaround/queue' && route.view === 'work-orders' && view === null));
          }
          if (action === 'jobs') return !!hit.closest('[data-demo-id="turnaround-queue-tab-jobs"]');
          const link = hit.closest('a[href]'); if (!link) return false;
          const url = new URL(link.href, location.href);
          if (url.origin !== location.origin) return false;
          if (action === 'scope-list') return url.pathname === '/turnaround/queue';
          const tab = document.querySelector('[data-demo-id="turnaround-queue-tab-jobs"]');
          return !!tab && (tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('data-state') === 'active') && url.pathname.startsWith('/turnaround/items/');
        })()`, true) as boolean;
        if (!this.playing || this.win !== win || generation !== this.generation) break;
        if (!valid) throw new Error('The demo target moved before the click. No click was sent.');
        win.webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        this.completed++;
        const verifyUntil = Date.now() + 10_000;
        let verified = false;
        while (!verified && Date.now() < verifyUntil && this.win === win && generation === this.generation) {
          await new Promise(resolve => setTimeout(resolve, 200));
          const current = new URL(win.webContents.getURL());
          if (current.origin !== ORIGIN) throw new Error('The demo left the approved local application.');
          if (route) verified = await routeReached(win.webContents, route);
          else if (action.action === 'scope-list') verified = current.pathname === '/turnaround/queue';
          else if (action.action === 'first-job') verified = current.pathname.startsWith('/turnaround/items/');
          else if (current.pathname === '/turnaround/queue') verified = await win.webContents.executeJavaScript(`(() => {
            const tab = document.querySelector('[data-demo-id="turnaround-queue-tab-jobs"]');
            return !!tab && (tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('data-state') === 'active');
          })()`, true) as boolean;
        }
        if (this.win !== win || generation !== this.generation) break;
        if (!verified) throw new Error(`The demo did not confirm ${action.action}. No further actions will run.`);
      }
    } catch (error) {
      if (this.win === win && generation === this.generation) {
        this.playing = false;
        this.failed(error instanceof Error ? error.message : 'The demo could not continue.');
      }
    } finally {
      this.busy = false;
      if (this.completed >= this.actions.length && this.draining) {
        this.draining = false;
        this.playing = false;
      }
      if (this.playing && this.win && this.actions[this.completed]?.at !== undefined
        && this.actions[this.completed]!.at <= this.position) void this.run();
    }
  }
}
