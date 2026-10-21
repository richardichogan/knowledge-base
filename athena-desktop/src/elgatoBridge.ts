import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ELGATO_PORT, parseCommand, type CommandRequest, type DesktopCommandState } from './elgatoProtocol';

export class ElgatoBridge {
  private server: Server | null = null;
  private results = new Map<string, { at: number; command: string; result: Promise<void> }>();
  private busy = false;
  constructor(
    private execute: (request: CommandRequest) => Promise<void>,
    private state: () => DesktopCommandState,
  ) {}
  async start(token: string, port = ELGATO_PORT): Promise<void> {
    await this.stop();
    const server = createServer((req, res) => { void this.respond(req, res, token); });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.maxHeadersCount = 20;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', error => { console.error('[Stream Deck] Local bridge failed:', error); });
    this.server = server;
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.results.clear();
    if (server) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  private async respond(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const send = (status: number, data: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (req.headers.origin !== undefined || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      send(403, { error: 'Pair this plugin in Athena Desktop.' }); return;
    }
    if (req.method === 'GET' && req.url === '/state') { send(200, this.state()); return; }
    if (req.method !== 'POST' || req.url !== '/command') { send(404, { error: 'Unknown endpoint.' }); return; }
    if (req.headers['content-type'] !== 'application/json') { send(415, { error: 'JSON is required.' }); return; }
    try {
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 2048) { send(413, { error: 'Command too large.' }); return; }
      }
      const request = parseCommand(JSON.parse(body));
      for (const [id, result] of this.results) if (Date.now() - result.at > 60_000) this.results.delete(id);
      let cached = this.results.get(request.id);
      if (cached && cached.command !== request.command) throw new Error('This request ID was already used for a different command.');
      if (!cached) {
        if (this.busy || this.results.size >= 256) { send(429, { error: 'Athena is busy. Try again.' }); return; }
        this.busy = true;
        const result = this.execute(request).finally(() => { this.busy = false; });
        cached = { at: Date.now(), command: request.command, result };
        this.results.set(request.id, cached);
      }
      await cached.result;
      send(200, { ok: true, id: request.id });
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : 'Command failed.' });
    }
  }
}
