import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PresentationVisualScene } from './elgatoProtocol';

export class VisualOutput {
  private server: Server | null = null;
  private clients = new Set<ServerResponse>();
  private address = '';
  private opening: Promise<string> | null = null;
  private generation = 0;
  private packet: { scene: PresentationVisualScene | null; revealed: number; error: string | null; page: number; total: number; presentationTitle: string } =
    { scene: null, revealed: 0, error: null, page: 0, total: 0, presentationTitle: '' };
  constructor(private readonly assets: string) {}

  update(scenes: PresentationVisualScene[], position: number, error: string | null, presentationTitle = ''): void {
    const scene = [...scenes].reverse().find(scene => scene.at <= position) ?? null;
    const packet = { scene, revealed: scene?.items.filter(item => item.at <= position).length ?? 0, error,
      page: scene ? scenes.indexOf(scene) + 1 : 0, total: scenes.length, presentationTitle };
    if (JSON.stringify(this.packet) === JSON.stringify(packet)) return;
    this.packet = packet;
    for (const client of this.clients) client.write(`data: ${JSON.stringify(packet)}\n\n`);
  }

  async open(): Promise<string> {
    if (this.opening) return this.opening;
    this.opening = this.start();
    try { return await this.opening; } finally { this.opening = null; }
  }

  private async start(): Promise<string> {
    if (this.server) return this.address;
    const generation = this.generation;
    const token = randomBytes(32).toString('hex');
    const files = new Map(await Promise.all(['visuals.html', 'visuals.js', 'visuals.css'].map(async name =>
      [name, await readFile(join(this.assets, name))] as const)));
    if (generation !== this.generation) throw new Error('The presentation closed before the browser output was ready.');
    const server = createServer((request, response) => {
      const expected = new URL(this.address);
      if (request.method !== 'GET' || request.headers.host !== expected.host
        || request.headers.origin && request.headers.origin !== expected.origin) {
        response.writeHead(403).end(); return;
      }
      const path = request.url;
      const base = `/${token}/`;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      if (path === `${base}events`) {
        if (this.clients.size >= 8) { response.writeHead(429).end(); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        response.write(`data: ${JSON.stringify(this.packet)}\n\n`);
        this.clients.add(response);
        const heartbeat = setInterval(() => { response.write(': keep-alive\n\n'); }, 15_000);
        response.on('close', () => { clearInterval(heartbeat); this.clients.delete(response); });
        return;
      }
      const name = path === base ? 'visuals.html' : path?.startsWith(base) ? path.slice(base.length) : '';
      const file = files.get(name ?? '');
      if (!file) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
      response.end(file);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Could not open the local visual output.')); return; }
        this.address = `http://127.0.0.1:${address.port}/${token}/`;
        resolve();
      });
    });
    if (generation !== this.generation) {
      server.close(); server.closeAllConnections();
      this.address = '';
      throw new Error('The presentation closed before the browser output was ready.');
    }
    server.on('error', error => { console.error('[Visual output] Local server failed:', error); this.close(); });
    this.server = server;
    return this.address;
  }

  close(): void {
    this.generation++;
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    this.address = '';
  }
}
