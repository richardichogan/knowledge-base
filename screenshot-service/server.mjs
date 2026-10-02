/**
 * screenshot-service — renders a public web page (or an HTML mock-up) to
 * JPEG images at the requested device sizes, for Athena to look at.
 *
 * POST /shot  (header x-shot-key)
 *   { url?: string, html?: string, devices?: ["desktop" | "tablet" | "mobile"], fullPage?: boolean }
 *   → { images: [{ device, width, height, mimeType, base64 }], title, finalUrl }
 *   (fullPage captures cover up to about three screens from the top)
 * GET /health → ok
 *
 * Safety: needs the shared key; http(s) only; every request the page makes
 * (including redirects) is checked and anything resolving to a private,
 * loopback, link-local or metadata address is blocked; one capture at a
 * time; 30s limit; full-page captures are capped in height.
 */
import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 8080);
const KEY = process.env.SHOT_KEY ?? '';
const NAV_TIMEOUT_MS = 30_000;
const MAX_FULL_HEIGHT = 6_000;
const SCREENS_PER_CAPTURE = 3;
const MAX_BODY_BYTES = 2_000_000;
const DEVICES = {
  desktop: { width: 1440, height: 900, isMobile: false, scale: 1 },
  tablet: { width: 820, height: 1180, isMobile: true, scale: 1 },
  mobile: { width: 390, height: 844, isMobile: true, scale: 2 },
};

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

const hostVerdicts = new Map();
async function hostAllowed(hostname) {
  if (hostVerdicts.has(hostname)) return hostVerdicts.get(hostname);
  let ok = false;
  try {
    if (net.isIP(hostname)) ok = !isPrivateIp(hostname);
    else {
      const addrs = await dns.lookup(hostname, { all: true });
      ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
    }
  } catch { ok = false; }
  if (hostVerdicts.size > 500) hostVerdicts.clear();
  hostVerdicts.set(hostname, ok);
  return ok;
}

async function urlAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return hostAllowed(u.hostname.replace(/^\[|\]$/g, ''));
}

let browserPromise = null;
function browser() {
  browserPromise ??= chromium.launch({ args: ['--disable-dev-shm-usage'] }).then((b) => {
    b.on('disconnected', () => { browserPromise = null; });
    return b;
  }).catch((err) => { browserPromise = null; throw err; });
  return browserPromise;
}

async function capture({ url, html, devices, fullPage }) {
  const b = await browser();
  const images = [];
  let title = '';
  let finalUrl = url ?? '';
  for (const name of devices) {
    const d = DEVICES[name];
    const context = await b.newContext({
      viewport: { width: d.width, height: d.height }, isMobile: d.isMobile, hasTouch: d.isMobile,
      deviceScaleFactor: d.scale, javaScriptEnabled: true, serviceWorkers: 'block',
      userAgent: d.isMobile
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        : undefined,
    });
    try {
      // Every request (navigations, redirects, sub-resources) must go to a public address.
      await context.route('**/*', async (route) => {
        const reqUrl = route.request().url();
        if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:') || reqUrl === 'about:blank') return route.continue();
        return (await urlAllowed(reqUrl)) ? route.continue() : route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);
      if (html !== undefined) {
        await page.setContent(html, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      } else {
        await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
        finalUrl = page.url();
      }
      await page.waitForTimeout(1200); // late-loading fonts, images and animations
      title = title || await page.title().catch(() => '');
      let clip;
      if (fullPage) {
        const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => d.height);
        // About three screens: tall captures get shrunk until unreadable when a model looks at them.
        clip = { x: 0, y: 0, width: d.width, height: Math.min(Math.max(height, d.height), d.height * SCREENS_PER_CAPTURE, MAX_FULL_HEIGHT) };
      }
      const buffer = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: Boolean(fullPage), ...(clip && { clip }) });
      images.push({ device: name, width: d.width, height: clip?.height ?? d.height, mimeType: 'image/jpeg', base64: buffer.toString('base64') });
    } finally {
      await context.close().catch(() => {});
    }
  }
  return { images, title, finalUrl };
}

// One capture at a time — the container is small.
let queue = Promise.resolve();
function enqueue(job) {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/shot') return send(res, 404, { error: 'not found' });
  if (KEY === '' || req.headers['x-shot-key'] !== KEY) return send(res, 401, { error: 'unauthorised' });
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) req.destroy(); else chunks.push(c); });
  req.on('end', async () => {
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
    const devices = (Array.isArray(input.devices) ? input.devices : ['desktop', 'mobile']).filter((d) => d in DEVICES).slice(0, 3);
    if (devices.length === 0) return send(res, 400, { error: 'no valid devices' });
    const html = typeof input.html === 'string' && input.html.trim() !== '' ? input.html : undefined;
    const url = typeof input.url === 'string' ? input.url.trim() : undefined;
    if (html === undefined && (url === undefined || !(await urlAllowed(url)))) {
      return send(res, 400, { error: 'url must be a public http(s) address' });
    }
    try {
      const result = await enqueue(() => Promise.race([
        capture({ url, html, devices, fullPage: input.fullPage !== false }),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('timed out')), NAV_TIMEOUT_MS * devices.length + 15_000)),
      ]));
      send(res, 200, result);
    } catch (err) {
      send(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}).listen(PORT, () => { console.log(`screenshot-service listening on ${PORT}`); });
