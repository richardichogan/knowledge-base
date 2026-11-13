import { BrowserWindow, screen, type WebContents } from 'electron';
import { classifyUrl } from './navigation';
import { isWorkforceDemo, type PresentationDemoAction, type PresentationTurnaroundRoute } from './elgatoProtocol';
import { locateInspection, type DemoPair, type InspectionTarget } from './demoInspection';
import type { DemoStep } from './demoSteps';
import { locateWorkforceElement } from './workforceInspection';

const ORIGIN = 'http://localhost:5173';
const START = `${ORIGIN}/turnaround/overview`;
const PARTITION = 'persist:athena-turnaround-demo';
const ROUTES: Record<PresentationTurnaroundRoute, { path: string; view?: string }> = {
  overview: { path: '/turnaround/overview' },
  plan: { path: '/turnaround/plan' },
  scopeList: { path: '/turnaround/queue' },
  challenge: { path: '/turnaround/challenge' },
  finalScope: { path: '/turnaround/final-scope' },
  scenarioPlanner: { path: '/turnaround/twin' },
  productionImpact: { path: '/turnaround/production-impact' },
  gate: { path: '/turnaround/gate' },
  audit: { path: '/turnaround/audit' },
  workforce: { path: '/agents', view: 'wf_turnaround' },
};

function routeMatches(url: URL, route: { path: string; view?: string }): boolean {
  if (route.path === '/agents') return url.pathname === route.path && url.searchParams.get('workforce') === route.view;
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
  private opening = false;
  private draining = false;
  private busy = false;
  private generation = 0;
  private displayId: number | null = null;
  private pair: DemoPair = {};
  private workforce = false;

  constructor(private readonly failed: (message: string) => void) {}

  get isOpening(): boolean { return this.opening; }
  get isReady(): boolean { return !!this.win && !this.opening && !this.win.isDestroyed(); }

  async open(displayId: number, prompterId: number | null, actions: PresentationDemoAction[]): Promise<void> {
    const workforce = isWorkforceDemo(actions);
    const display = screen.getAllDisplays().find(item => item.id === displayId);
    if (!display || display.id === screen.getPrimaryDisplay().id || display.id === prompterId) {
      throw new Error('Choose a demo display separate from the presenter and prompter.');
    }
    this.close();
    this.opening = true;
    const generation = this.generation;
    this.actions = actions;
    this.workforce = workforce;
    this.completed = 0;
    this.pair = {};
    const win = new BrowserWindow({ ...display.bounds, frame: false, show: false, autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    this.win = win;
    this.displayId = display.id;
    guard(win.webContents);
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null; this.displayId = null; this.generation++; this.playing = false;
      this.opening = false;
      this.failed('The Turnaround demo window closed. Reopen it before continuing.');
    });
    try {
      await win.loadURL(workforce ? `${ORIGIN}/agents?workforce=wf_turnaround` : START);
      if (this.win !== win) throw new Error('Demo window was closed.');
      win.show();
      await this.waitUntilReady(win, generation);
      this.opening = false;
    } catch (error) {
      this.opening = false;
      if (!win.isDestroyed()) win.close();
      throw error;
    }
  }

  async reset(prompterId: number | null): Promise<void> {
    if (!this.isReady || this.displayId === null) return;
    await this.open(this.displayId, prompterId, this.actions);
  }

  close(): void {
    this.generation++;
    this.playing = false;
    this.opening = false;
    this.draining = false;
    const win = this.win;
    this.win = null;
    this.displayId = null;
    if (win && !win.isDestroyed()) win.close();
  }

  private async waitUntilReady(win: BrowserWindow, generation: number): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (this.win === win && generation === this.generation && !win.isDestroyed() && Date.now() < deadline) {
      const currentUrl = win.webContents.getURL();
      if (currentUrl.startsWith(`${ORIGIN}/`)) {
        const url = new URL(currentUrl);
        if (this.workforce && routeMatches(url, ROUTES.workforce)) {
          const ready = await win.webContents.executeJavaScript(`(() => {
            const title = document.querySelector('.workforce-summary h3');
            return !!title && /Turnaround.*Workforce/.test(title.textContent ?? '')
              && !!document.querySelector('[data-demo-id="workforce-tab-composition"]');
          })()`, true) as boolean;
          if (ready) return;
        }
        if (!this.workforce && url.pathname === '/turnaround/overview') {
          const status = await win.webContents.executeJavaScript(`(() => {
            const overview = document.querySelector('[data-demo-id="turnaround-overview"]');
            const event = document.querySelector('#turnaround-event');
            if (!overview || !(event instanceof HTMLSelectElement)) return 'loading';
            const selected = event.selectedOptions[0]?.textContent ?? '';
            if (!selected.includes('NPT2-TA-2027')) return 'wrong-event';
            return document.querySelector('[data-demo-id="turnaround-standing"]') ? 'ready' : 'loading';
          })()`, true) as 'loading' | 'ready' | 'wrong-event';
          if (status === 'ready') return;
          if (status === 'wrong-event') {
            throw new Error('Select NPT2-TA-2027 in the demo before starting. The script remains paused.');
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (this.win !== win || generation !== this.generation || win.isDestroyed()) {
      throw new Error('The Turnaround demo window closed before it was ready. The script remains paused.');
    }
    throw new Error('The demo did not finish loading within 60 seconds. The script remains paused; sign in if prompted and reopen the demo.');
  }

  private expectedPage(url: URL): boolean {
    return url.origin === ORIGIN && (this.workforce
      ? routeMatches(url, ROUTES.workforce) || url.pathname === '/agents/agent_turnaround_challenge'
      : url.pathname.startsWith('/turnaround/'));
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

  private async inspect(win: BrowserWindow, target: DemoStep, generation: number): Promise<boolean> {
    const active = (): boolean => this.playing && this.win === win && generation === this.generation;
    if (!active()) return false;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.floor(win.getContentBounds().width / 2), y: 24 });
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!active()) return false;
    if (target === 'historical-back') {
      const current = new URL(win.webContents.getURL());
      if (!current.pathname.startsWith('/turnaround/precedent/')) return true;
      const history = win.webContents.navigationHistory;
      const previous = history.getEntryAtIndex(history.getActiveIndex() - 1);
      if (!this.pair.historicalReturn || current.origin !== ORIGIN || !previous
        || previous.url !== ORIGIN + this.pair.historicalReturn) throw new Error('The historical source return context changed. No unrelated page was opened.');
      if (!active()) return false;
      history.goBack();
      const deadline = Date.now() + 10_000;
      while (active() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (win.webContents.getURL() === ORIGIN + this.pair.historicalReturn) return true;
      }
      if (!active()) return false;
      throw new Error('Could not restore the selected job’s challenge context.');
    }
    const locate = async (scroll: boolean): Promise<InspectionTarget | null> => {
      const url = new URL(win.webContents.getURL());
      if (!this.expectedPage(url)) throw new Error('The demo left its approved application screens.');
      return win.webContents.executeJavaScript(`(${locateInspection.toString()})(${JSON.stringify(target)},${JSON.stringify(this.pair)},${scroll},${locateWorkforceElement.toString()})`, true);
    };
    const deadline = Date.now() + 10_000;
    let advanced = false;
    while (active() && Date.now() < deadline) {
      const item = await locate(true);
      if (!item) { await new Promise(resolve => setTimeout(resolve, 200)); continue; }
      if (!active()) return false;
      this.pair = item.pair;
      if (item.mode === 'done') return true;
      await new Promise(resolve => setTimeout(resolve, 550));
      if (!active()) return false;
      const check = await locate(false);
      if (!active()) return false;
      if (!check || check.key !== item.key || check.mode !== item.mode || check.x !== item.x || check.y !== item.y || check.value !== item.value) {
        if (target.startsWith('workforce-') && check?.key === item.key && check.mode === item.mode && check.value === item.value) {
          continue;
        }
        throw new Error(`The ${target} target changed. No click was sent.`);
      }
      win.webContents.sendInputEvent({ type: 'mouseMove', x: item.x, y: item.y });
      if (item.mode !== 'click' && item.mode !== 'fill') return true;
      win.webContents.sendInputEvent({ type: 'mouseDown', x: item.x, y: item.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: item.x, y: item.y, button: 'left', clickCount: 1 });
      if (item.mode === 'fill') {
        if (!this.workforce || item.value === undefined || !['', 'Scope Challenge', 'Scope Challenge Specialist'].includes(item.value)) {
          throw new Error('The workforce search value was not approved. Nothing was typed.');
        }
        const focused = await win.webContents.executeJavaScript(`(() => {
          const target = (${locateWorkforceElement.toString()})(${JSON.stringify(target)});
          return target.el instanceof HTMLInputElement && target.el === document.activeElement
            && !target.el.disabled && !target.el.readOnly;
        })()`, true) as boolean;
        if (!active()) return false;
        if (!focused) throw new Error('The workforce search field did not receive focus. Nothing was typed.');
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        if (item.value) await win.webContents.insertText(item.value);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      // Re-resolve the named target to confirm the new page/expanded state; never blindly repeat a click.
      while (active() && Date.now() < deadline) {
        const current = new URL(win.webContents.getURL());
        if (current.origin !== ORIGIN) throw new Error('The demo left the approved local application.');
        if (item.destination && current.pathname + current.search === item.destination) return true;
        const result = await locate(false);
        if (!active()) return false;
        if (result && (result.mode === 'point' || result.mode === 'done')) return true;
        if (result?.mode === 'click' && result.key !== item.key) { advanced = true; break; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!active()) return false;
      if (advanced) continue;
      throw new Error(`The demo did not confirm ${target}. No further actions will run.`);
    }
    if (!active()) return false;
    throw new Error(`Could not find ${target}. The demo has paused; no replacement record was selected.`);
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
        if (action.action === 'inspect') {
          if (action.selection) {
            const jobPath = `/turnaround/items/${encodeURIComponent(action.selection.jobId)}`;
            if (this.pair.jobPath && (this.pair.jobPath !== jobPath || this.pair.orderId !== action.selection.workOrderId)) {
              throw new Error('The walkthrough pair changed. No different record was substituted.');
            }
            this.pair = { ...this.pair, jobPath, orderId: action.selection.workOrderId };
          }
          if (!await this.inspect(win, action.target, generation) || this.win !== win || generation !== this.generation) break;
          this.completed++;
          continue;
        }
        const deadline = Date.now() + 10_000;
        let target: { x: number; y: number } | null = null;
        const route = action.action === 'navigate' ? ROUTES[action.route] : null;
        if (route) {
          const current = new URL(win.webContents.getURL());
          if (!this.expectedPage(current)) {
            throw new Error('The demo is not on an approved Turnaround screen. Sign in and reopen the demo.');
          }
          const reached = await routeReached(win.webContents, route);
          if (this.win !== win || generation !== this.generation) break;
          if (reached) { this.completed++; continue; }
          win.webContents.sendInputEvent({ type: 'mouseMove',
            x: Math.floor(win.getContentBounds().width / 2), y: 24 });
          await new Promise(resolve => setTimeout(resolve, 250));
          if (!this.playing || this.win !== win || generation !== this.generation) break;
        }
        while (!target && Date.now() < deadline && this.playing && this.win === win && generation === this.generation) {
          const current = new URL(win.webContents.getURL());
          if (current.origin !== ORIGIN || (route
            ? !this.expectedPage(current)
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
                const view = url.searchParams.get(route.path === '/agents' ? 'workforce' : 'view');
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
            const view = url.searchParams.get(route.path === '/agents' ? 'workforce' : 'view');
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
