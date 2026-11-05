import { DefaultAzureCredential } from '@azure/identity';
import { BlobSASPermissions, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { randomUUID } from 'node:crypto';
import { getAthenaStorage } from './athenaStorage.js';
import { getDb } from '../db/db.js';
import { AiError } from '../types/errors.js';
import { IMAGE_SAS_EXPIRY_YEARS, BLOB_UPLOAD_TIMEOUT_MS } from '../config/constants.js';
import { recordAiUsage, tokenUsageFrom } from '../ai/aiUsage.js';
import { analyzeImageWithVision } from './visionAnalyzer.js';

const IMAGE_DEPLOYMENT = 'gpt-image-2.5-sunburst';
const IMAGE_ENDPOINT = 'https://aif-foundryiq.services.ai.azure.com/openai/v1/images/generations';
const IMAGE_TIMEOUT_MS = 150_000;
const MAX_ENCODED_IMAGE_LENGTH = 34_000_000;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const credential = new DefaultAzureCredential();

export async function generateScriptVisualImage(prompt: string, description: string, signal?: AbortSignal): Promise<string> {
  const startedAt = Date.now();
  const timeout = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
  const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const storage = getAthenaStorage();
  let usage: ReturnType<typeof tokenUsageFrom> | undefined;
  try {
    const token = await credential.getToken('https://ai.azure.com/.default', { abortSignal });
    const response = await fetch(IMAGE_ENDPOINT, {
      method: 'POST', signal: abortSignal,
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_DEPLOYMENT, n: 1, size: '1536x1024', quality: 'high',
        prompt: `Create a refined editorial illustration for a Carbon g100 audience presentation. ${prompt}
Use neutral charcoal (#161616, #262626), restrained teal, Carbon blue and white. Sophisticated, intentional composition, clear silhouette, dimensional subject with material detail, generous negative space. Not clip art, random geometry, a screenshot or a slide.
NO typography, captions, logos, letters, labels, numbers or watermarks. All presentation text and animated connections are separate browser elements. The subject must explain the supplied concept without inventing evidence or product claims.` }),
    });
    if (!response.ok) throw new AiError(`Sunburst image generation failed (${response.status}). No replacement visuals were saved.`);
    const raw: unknown = await response.json();
    const result = raw as { data?: Array<{ b64_json?: unknown }>; usage?: Record<string, unknown> };
    usage = tokenUsageFrom(result.usage);
    const encoded = result.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || encoded.length > MAX_ENCODED_IMAGE_LENGTH) throw new AiError('Sunburst returned an invalid or oversized image.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new AiError('Sunburst did not return a PNG image.');
    abortSignal.throwIfAborted();
    const analysis = await analyzeImageWithVision(bytes, 'image/png',
      'Describe the actual illustration, its subjects, relationships and composition. This is generated supporting artwork, not evidence that a real event occurred. Report any text actually visible. Do not treat the requested design brief as visual evidence.',
      { signal: abortSignal });
    if (!analysis.trim()) throw new AiError('The generated illustration could not be read for Athena. No replacement visuals were saved.');
    abortSignal.throwIfAborted();
    const id = randomUUID();
    const blob = storage.service.getContainerClient('kb-images').getBlockBlobClient(id);
    await blob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: 'image/png' },
      abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(BLOB_UPLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(BLOB_UPLOAD_TIMEOUT_MS) });
    const expiresOn = new Date();
    expiresOn.setFullYear(expiresOn.getFullYear() + IMAGE_SAS_EXPIRY_YEARS);
    const sas = generateBlobSASQueryParameters({
      containerName: 'kb-images', blobName: id, permissions: BlobSASPermissions.parse('r'), expiresOn,
    }, storage.credential).toString();
    const url = `${blob.url}?${sas}`;
    try {
      await getDb().query(
        `INSERT INTO kb_images (id, blob_url, ocr_text, vision_analysis, caption) VALUES ($1,$2,'',$3,$4)`,
        [id, url, analysis, description],
      );
    } catch (error) {
      await blob.deleteIfExists().catch(cleanupError => { console.error('[Script visuals] Failed to remove an unregistered generated image:', cleanupError); });
      throw error;
    }
    recordAiUsage({ feature: 'script-visual-images', persona: 'ariadne', slot: 'images', deployment: IMAGE_DEPLOYMENT,
      api: 'images', durationMs: Date.now() - startedAt, ok: true, ...usage });
    return url;
  } catch (error) {
    recordAiUsage({ feature: 'script-visual-images', persona: 'ariadne', slot: 'images', deployment: IMAGE_DEPLOYMENT,
      api: 'images', durationMs: Date.now() - startedAt, ok: false, error: error instanceof Error ? error.message : String(error), ...usage });
    console.error('[Script visuals] Sunburst image generation or storage failed:', error instanceof Error ? error.message : error);
    throw error;
  }
}
