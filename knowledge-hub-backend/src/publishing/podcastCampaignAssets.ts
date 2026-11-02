import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { Resvg } from '@resvg/resvg-js';
import { BlobSASPermissions, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { getAthenaStorage } from '../services/athenaStorage.js';
import { ValidationError } from '../types/errors.js';
import type { PodcastAssetSpec, PodcastImageAsset, PodcastPlan } from './podcastCampaign.js';
import { validateSocialImage, type SocialImage } from '../integrations/social/image.js';

const folder = new URL('./assets/', import.meta.url);
const logo = readFileSync(new URL('podcast-logo.png', folder)).toString('base64');
const fonts = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-SemiBold.ttf'].map(name => fileURLToPath(new URL(name, folder)));
const fontOptions = { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' };
const ARTWORK = {
  quoteWidth: 1080, landscapeWidth: 1200, quoteHeight: 1080, landscapeHeight: 675,
  quoteFont: 58, landscapeFont: 64, horizontalInset: 192, quoteTextHeight: 420,
  landscapeTextHeight: 215, lineHeight: 1.25, minFont: 32, fontStep: 2,
  quoteTop: 396, landscapeTop: 302, panelStart: 0.66, panelEnd: 0.84,
  footerRule: 128, margin: 64, footerTitle: 82, footerSubtitle: 46,
} as const;
const PNG_OFFSET = { width: 16, height: 20 } as const;
const UUID_POSITION = { first: 8, second: 12, version: 13, third: 16, variant: 17, fourth: 20, end: 32 } as const;
const CONSTELLATION = [
  { x: .76, y: .12 }, { x: .88, y: .22 }, { x: .81, y: .36 }, { x: .94, y: .43 },
  { x: .73, y: .65 }, { x: .87, y: .79 }, { x: .96, y: .91 },
];
const xml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function measure(text: string, size: number): number {
  const box = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="200"><text x="0" y="100" font-family="IBM Plex Sans" font-weight="600" font-size="${size}">${xml(text)}</text></svg>`,
    { font: fontOptions },
  ).innerBBox();
  if (!box || box.width <= 0) throw new ValidationError('The podcast artwork text could not be measured with its bundled font.');
  return box.width;
}

function wrap(text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, size) <= width) { line = candidate; continue; }
    if (!line || measure(word, size) > width) throw new ValidationError('A podcast artwork word cannot fit without truncation.');
    lines.push(line); line = word;
  }
  if (line) lines.push(line);
  return lines;
}

export function renderPodcastArtwork(spec: PodcastAssetSpec): { svg: string; png: Buffer; width: number; height: number; alt: string } {
  const isQuote = spec.kind === 'quote';
  const width = isQuote ? ARTWORK.quoteWidth : ARTWORK.landscapeWidth;
  const height = isQuote ? ARTWORK.quoteHeight : ARTWORK.landscapeHeight;
  const accent = /^David\b/i.test(spec.speaker ?? '') ? '#78a9ff' : /^Cyrus\b/i.test(spec.speaker ?? '') ? '#be95ff' : '#3ddbd9';
  const tint = accent === '#78a9ff' ? '#142138' : accent === '#be95ff' ? '#271c38' : '#102427';
  const content = isQuote ? spec.quote ?? '' : spec.headline;
  if (!content.trim()) throw new ValidationError('The podcast image has no source text.');
  let size: number = isQuote ? ARTWORK.quoteFont : ARTWORK.landscapeFont;
  let lines = wrap(content, size, width - ARTWORK.horizontalInset);
  const maxHeight = isQuote ? ARTWORK.quoteTextHeight : ARTWORK.landscapeTextHeight;
  while (lines.length * size * ARTWORK.lineHeight > maxHeight && size > ARTWORK.minFont) {
    size -= ARTWORK.fontStep; lines = wrap(content, size, width - ARTWORK.horizontalInset);
  }
  if (lines.length * size * ARTWORK.lineHeight > maxHeight) throw new ValidationError('The exact podcast quote is too long for its card. Select a shorter complete source quote; it has not been truncated.');
  const constellation = CONSTELLATION.map(({ x, y }, index) => `<circle cx="${x * width}" cy="${y * height}" r="3" fill="${accent}" opacity=".22"/>`
    + (index ? `<path d="M${CONSTELLATION[index - 1]!.x * width} ${CONSTELLATION[index - 1]!.y * height}L${x * width} ${y * height}" stroke="${accent}" opacity=".09"/>` : '')).join('');
  const top = isQuote ? ARTWORK.quoteTop : ARTWORK.landscapeTop;
  const footer = spec.episodeNumber === null ? 'THIS EPISODE' : `EPISODE ${spec.episodeNumber}`;
  const alt = isQuote ? `${spec.speaker}: “${content}”${spec.timestamp ? ` (${spec.timestamp})` : ''}. ${footer}.`
    : `${spec.kind === 'teaser' ? 'Recorded — releasing Monday' : 'Cloudy with a Chance of Insights'}. ${content}. ${footer}.`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <title>${xml(alt)}</title><rect width="${width}" height="${height}" fill="#161616"/>
    <path d="M${width * ARTWORK.panelStart} 0H${width}V${height}H${width * ARTWORK.panelEnd}Z" fill="${tint}" opacity=".55"/>${constellation}
    <g font-family="IBM Plex Sans">
      <defs><clipPath id="logo"><circle cx="96" cy="84" r="31"/></clipPath></defs>
      <image href="data:image/png;base64,${logo}" x="64" y="52" width="64" height="64" clip-path="url(#logo)"/>
      <text x="148" y="80" fill="#f4f4f4" font-size="23" font-weight="600">Cloudy with a Chance of Insights</text>
      <text x="148" y="110" fill="#c6c6c6" font-size="18">The Microsoft Cloud Podcast</text>
      ${isQuote ? `<text x="64" y="290" fill="${accent}" font-size="130" font-weight="600">“</text>`
        : `<text x="64" y="210" fill="#3ddbd9" font-size="23" font-weight="600">${spec.kind === 'teaser' ? 'RECORDED · RELEASING MONDAY' : spec.kind === 'launch' ? 'NEW EPISODE' : 'FROM THE EPISODE'}</text>`}
      ${lines.map((line, index) => `<text x="64" y="${top + index * size * ARTWORK.lineHeight}" fill="#f4f4f4" font-size="${size}" font-weight="600">${xml(line)}</text>`).join('')}
      ${isQuote ? `<text x="64" y="802" fill="${accent}" font-size="25" font-weight="600">${xml(spec.speaker ?? '')}</text>
        <text x="64" y="840" fill="#c6c6c6" font-size="21">${xml(footer)}${spec.timestamp ? ` · ${xml(spec.timestamp)}` : ''}</text>` : ''}
      <path d="M64 ${height - ARTWORK.footerRule}H${width - ARTWORK.margin}" stroke="#525252"/>
      <text x="64" y="${height - ARTWORK.footerTitle}" fill="#3ddbd9" font-size="22" font-weight="600">${xml(footer)}</text>
      <text x="64" y="${height - ARTWORK.footerSubtitle}" fill="#c6c6c6" font-size="19">${spec.kind === 'teaser' ? 'Episode links available on release' : 'Cloudy with a Chance of Insights · The Microsoft Cloud Podcast'}</text>
    </g></svg>`;
  const png = Buffer.from(new Resvg(svg, { font: fontOptions }).render().asPng());
  if (png.readUInt32BE(PNG_OFFSET.width) !== width || png.readUInt32BE(PNG_OFFSET.height) !== height) throw new ValidationError('The podcast image renderer returned incorrect dimensions.');
  return { svg, png, width, height, alt };
}

export async function generatePodcastAssets(db: Pick<Pool, 'query'>, plan: PodcastPlan, signal?: AbortSignal): Promise<void> {
  const { service, credential } = getAthenaStorage();
  const container = service.getContainerClient('kb-images');
  for (const post of plan.posts) {
    signal?.throwIfAborted();
    const spec = post.assetSpec;
    if (!spec) throw new ValidationError(`${post.label}: no image source was selected. The campaign has not been approved.`);
    const sourceHash = createHash('sha256').update(JSON.stringify(['podcast-carbon-v1', spec])).digest('hex');
    const imageId = `${sourceHash.slice(0, UUID_POSITION.first)}-${sourceHash.slice(UUID_POSITION.first, UUID_POSITION.second)}-4${sourceHash.slice(UUID_POSITION.version, UUID_POSITION.third)}-a${sourceHash.slice(UUID_POSITION.variant, UUID_POSITION.fourth)}-${sourceHash.slice(UUID_POSITION.fourth, UUID_POSITION.end)}`;
    const image = renderPodcastArtwork(spec);
    const blob = container.getBlockBlobClient(imageId);
    const existing = await db.query<{ id: string }>('SELECT id FROM kb_images WHERE id=$1', [imageId]);
    if (!existing.rowCount) {
      await blob.uploadData(image.png, { blobHTTPHeaders: { blobContentType: 'image/png' }, ...(signal && { abortSignal: signal }) });
      await container.getBlockBlobClient(`${imageId}.svg`).uploadData(Buffer.from(image.svg), { blobHTTPHeaders: { blobContentType: 'image/svg+xml' }, ...(signal && { abortSignal: signal }) });
    }
    const savedPng = existing.rowCount ? await blob.downloadToBuffer() : image.png;
    validateSocialImage({ bytes: savedPng, alt: image.alt, mimeType: 'image/png' });
    if (savedPng.readUInt32BE(PNG_OFFSET.width) !== image.width || savedPng.readUInt32BE(PNG_OFFSET.height) !== image.height) {
      throw new ValidationError('The cached podcast image does not match its required dimensions.');
    }
    const expiresOn = new Date();
    expiresOn.setFullYear(expiresOn.getFullYear() + 1);
    const sas = generateBlobSASQueryParameters({ containerName: 'kb-images', blobName: imageId, permissions: BlobSASPermissions.parse('r'), expiresOn }, credential).toString();
    const url = `${blob.url}?${sas}`;
    await db.query(`INSERT INTO kb_images(id,blob_url,caption,ocr_text,vision_analysis) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET blob_url=EXCLUDED.blob_url`,
    [imageId, url, image.alt, [spec.headline, spec.quote, spec.speaker, spec.timestamp].filter(Boolean).join('\n'),
      `Deterministically rendered podcast artwork from saved source: ${JSON.stringify(spec)}. Exact text and speaker colour are known; no generated photographic imagery.`]);
    post.asset = { imageId, url, width: image.width, height: image.height, alt: image.alt, sourceHash,
      contentHash: createHash('sha256').update(savedPng).digest('hex') } satisfies PodcastImageAsset;
  }
}

export async function loadPodcastImage(asset: PodcastImageAsset): Promise<SocialImage> {
  const bytes = await getAthenaStorage().service.getContainerClient('kb-images').getBlockBlobClient(asset.imageId).downloadToBuffer();
  if (createHash('sha256').update(bytes).digest('hex') !== asset.contentHash) throw new ValidationError('The podcast image changed after review. No post was sent.');
  const image: SocialImage = { bytes: new Uint8Array(bytes), alt: asset.alt, mimeType: 'image/png' };
  validateSocialImage(image);
  return image;
}

export async function loadPodcastArtworkSource(asset: PodcastImageAsset): Promise<Buffer> {
  return getAthenaStorage().service.getContainerClient('kb-images').getBlockBlobClient(`${asset.imageId}.svg`).downloadToBuffer();
}
