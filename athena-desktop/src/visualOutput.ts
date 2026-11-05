import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseVisualVideoMode, type PresentationVisualScene } from './elgatoProtocol';
import type { VisualVideoState } from '../assets/visualComposition';

export class VisualOutput {
  private server: Server | null = null;
  private clients = new Map<ServerResponse, string>();
  private cameraClient: string | null = null;
  private videoSequence = 0;
  private video: VisualVideoState = { mode: 'guide', status: 'idle', error: null, requestId: '' };
  private address = '';
  private opening: Promise<string> | null = null;
  private generation = 0;
  private packet: { scene: PresentationVisualScene | null; revealed: number; error: string | null; page: number; total: number; presentationTitle: string } =
    { scene: null, revealed: 0, error: null, page: 0, total: 0, presentationTitle: '' };
  constructor(private readonly assets: string, private readonly videoChanged: () => void = () => {}) {}

  videoState(): VisualVideoState { return { ...this.video }; }
  hasClients(): boolean { return this.clients.size > 0; }

  setVideoMode(value: unknown): void {
    const mode = parseVisualVideoMode(value);
    this.cameraClient = mode === 'camera' ? [...this.clients.values()].at(-1) ?? null : null;
    this.videoSequence = 0;
    this.video = { mode, status: mode === 'camera' ? 'waiting' : 'idle', error: null, requestId: randomUUID() };
    this.broadcast();
    this.videoChanged();
  }

  private send(client: ServerResponse, clientId: string): void {
    const video = this.video.mode === 'camera' && this.cameraClient !== clientId
      ? { ...this.video, mode: 'off' as const, status: 'idle' as const, error: null } : this.video;
    client.write(`data: ${JSON.stringify({ ...this.packet, video, videoClientId: clientId })}\n\n`);
  }

  private broadcast(): void {
    for (const [client, id] of this.clients) this.send(client, id);
  }

  private async cameraStatus(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      length += buffer.length;
      if (length > 1024) { response.writeHead(413).end(); return; }
      chunks.push(buffer);
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid camera status.');
    const data = raw as Record<string, unknown>;
    const status = (['waiting', 'requesting', 'active', 'error'] as const).find(status => status === data.status);
    if (Object.keys(data).some(key => !['clientId', 'requestId', 'sequence', 'status', 'error'].includes(key))
      || typeof data.sequence !== 'number' || !Number.isSafeInteger(data.sequence) || data.sequence < 1
      || !status
      || data.error !== null && (typeof data.error !== 'string' || data.error.length > 500)
      || data.status === 'error' && !data.error) throw new Error('Invalid camera status.');
    if (this.video.mode !== 'camera' || data.requestId !== this.video.requestId
      || data.clientId !== this.cameraClient || ![...this.clients.values()].includes(String(data.clientId))) {
      response.writeHead(409).end(); return;
    }
    if (data.sequence <= this.videoSequence) { response.writeHead(204).end(); return; }
    this.videoSequence = data.sequence;
    this.video = { ...this.video, status, error: status === 'error' ? String(data.error) : null };
    this.broadcast();
    this.videoChanged();
    response.writeHead(204).end();
  }

  update(scenes: PresentationVisualScene[], position: number, error: string | null, presentationTitle = ''): void {
    const scene = [...scenes].reverse().find(scene => scene.at <= position) ?? null;
    const packet = { scene, revealed: scene?.items.filter(item => item.at <= position).length ?? 0, error,
      page: scene ? scenes.indexOf(scene) + 1 : 0, total: scenes.length, presentationTitle };
    if (JSON.stringify(this.packet) === JSON.stringify(packet)) return;
    this.packet = packet;
    this.broadcast();
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
    const files = new Map(await Promise.all(['visuals.html', 'visuals.js', 'visuals.css', 'visualGeometry.js', 'visualVideo.js'].map(async name =>
      [name, await readFile(join(this.assets, name))] as const)));
    if (generation !== this.generation) throw new Error('The presentation closed before the browser output was ready.');
    const server = createServer((request, response) => {
      const expected = new URL(this.address);
      if (request.headers.host !== expected.host
        || request.headers.origin && request.headers.origin !== expected.origin) {
        response.writeHead(403).end(); return;
      }
      const path = request.url;
      const base = `/${token}/`;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src https:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      response.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
      if (request.method === 'POST' && path === `${base}video-status`
        && request.headers.origin === expected.origin && request.headers['content-type'] === 'application/json') {
        void this.cameraStatus(request, response).catch(error => {
          console.warn('[Visual output] Camera status rejected:', error);
          if (!response.headersSent) response.writeHead(400).end();
        });
        return;
      }
      if (request.method !== 'GET') { response.writeHead(403).end(); return; }
      if (path === `${base}events`) {
        if (this.clients.size >= 8) { response.writeHead(429).end(); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        const clientId = randomUUID();
        this.clients.set(response, clientId);
        if (this.video.mode === 'camera' && this.video.status === 'waiting' && !this.cameraClient) this.cameraClient = clientId;
        this.send(response, clientId);
        const heartbeat = setInterval(() => { response.write(': keep-alive\n\n'); }, 15_000);
        response.on('close', () => {
          clearInterval(heartbeat);
          this.clients.delete(response);
          if (this.cameraClient === clientId) {
            this.cameraClient = null;
            this.video = { ...this.video, status: 'error', error: 'The camera output disconnected. Reopen browser visuals and retry Camera from the script toolbar.' };
            this.broadcast();
            this.videoChanged();
          }
        });
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
    if (this.video.mode === 'camera') this.setVideoMode('off');
    for (const client of this.clients.keys()) client.end();
    this.clients.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    this.address = '';
  }
}
