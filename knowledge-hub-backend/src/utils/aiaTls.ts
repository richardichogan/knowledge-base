import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { Agent } from 'undici';

/**
 * Some sites (partner.microsoft.com) chain to a root Node does not ship, with a
 * published cross-signed certificate that does chain to one it trusts. Browsers
 * fetch that certificate from the "CA Issuers" address (AIA); Node does not.
 * This does the same, accepting the extra certificates only when every link
 * verifies up to a root already in Node's store. Verification is never disabled.
 */

const MISSING_ISSUER = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT']);
const MAX_LINKS = 3;
const MAX_CERT_BYTES = 64_000;
const CERT_TIMEOUT_MS = 5_000;
const AGENT_CACHE_LIMIT = 50;

const agents = new Map<string, Promise<Agent | null>>();
let roots: X509Certificate[] | undefined;

function errorCode(err: unknown): string | undefined {
  for (let current: unknown = err, depth = 0; current !== null && typeof current === 'object' && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isMissingIssuerError(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && MISSING_ISSUER.has(code);
}

function trustedRoots(): X509Certificate[] {
  roots ??= tls.rootCertificates.map(pem => new X509Certificate(pem));
  return roots;
}

function current(cert: X509Certificate): boolean {
  const now = Date.now();
  return Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);
}

function issuerUrl(cert: X509Certificate): string | undefined {
  return /CA Issuers - URI:(\S+)/.exec(cert.infoAccess ?? '')?.[1];
}

/** Reads the certificates the server presents; nothing is sent over the connection. */
function servedChain(host: string, port: number): Promise<X509Certificate[]> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: CERT_TIMEOUT_MS }, () => {
      const chain: X509Certificate[] = [];
      let peer: tls.DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
      const seen = new Set<string>();
      while (peer?.raw !== undefined && !seen.has(peer.fingerprint256)) {
        seen.add(peer.fingerprint256);
        chain.push(new X509Certificate(peer.raw));
        peer = peer.issuerCertificate;
      }
      socket.destroy();
      resolve(chain);
    });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('certificate read timed out')); });
    socket.on('error', reject);
  });
}

async function download(url: string, publicUrl: (raw: string) => Promise<URL>): Promise<X509Certificate> {
  const target = await publicUrl(url);
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(CERT_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`issuer certificate returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_CERT_BYTES) throw new Error('issuer certificate is too large');
  return new X509Certificate(bytes);
}

/** Certificates that complete the chain to a trusted root, or null when it cannot be completed safely. */
export async function completeChain(host: string, port: number, publicUrl: (raw: string) => Promise<URL>): Promise<string[] | null> {
  const chain = await servedChain(host, port);
  // A server may also send its own untrusted self-signed root; continue from the certificate it signed.
  while (chain.length > 1 && chain.at(-1)!.checkIssued(chain.at(-1)!)) chain.pop();
  let top = chain.at(-1);
  if (top === undefined) return null;
  const added: X509Certificate[] = [];
  for (let link = 0; link < MAX_LINKS; link++) {
    const child: X509Certificate = top;
    if (trustedRoots().some(root => child.checkIssued(root) && child.verify(root.publicKey))) {
      return added.length > 0 ? added.map(cert => cert.toString()) : null;
    }
    const url = issuerUrl(child);
    if (url === undefined) return null;
    const issuer = await download(url, publicUrl);
    if (!child.checkIssued(issuer) || !child.verify(issuer.publicKey) || !current(issuer) || !issuer.ca) return null;
    added.push(issuer);
    top = issuer;
  }
  return null;
}

/** An agent that trusts Node's roots plus the verified missing links for this host, or null. */
export function agentForHost(host: string, port: number, publicUrl: (raw: string) => Promise<URL>): Promise<Agent | null> {
  const key = `${host}:${port}`;
  let agent = agents.get(key);
  if (agent === undefined) {
    if (agents.size >= AGENT_CACHE_LIMIT) agents.delete(agents.keys().next().value as string);
    agent = completeChain(host, port, publicUrl)
      .then(extra => extra === null ? null : new Agent({ connect: { ca: [...tls.rootCertificates, ...extra] } }))
      .catch((err: unknown) => { console.warn(`[tls] could not complete the certificate chain for ${host}:`, err instanceof Error ? err.message : err); return null; });
    agents.set(key, agent);
    void agent.then(found => { if (found === null) agents.delete(key); });
  }
  return agent;
}
