/**
 * Images routes — Change 003
 *
 * POST /api/images   — upload an image, run OCR + GPT-4V vision analysis, store in kb-images blob container
 * GET  /api/images   — paginated list of images
 *
 * Vision analysis: Uses Azure OpenAI GPT-4V to understand image content semantically.
 * OCR: Azure AI Vision Read API extracts text as a fallback/supplement.
 * If neither credential is set, visionAnalysis and ocrText are empty strings.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { BlobServiceClient, BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } from '@azure/storage-blob';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { HTTP_STATUS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, OCR_MAX_POLLS, OCR_POLL_INTERVAL_MS, IMAGE_SAS_EXPIRY_YEARS, BLOB_UPLOAD_TIMEOUT_MS } from '../config/constants.js';
import { BlobStorageError, ValidationError } from '../types/index.js';
import { analyzeImageWithVision } from '../services/visionAnalyzer.js';
import type { ApiSuccess, PaginatedList, KnowledgeImage } from '../types/index.js';

const router = Router();

const KB_IMAGES_CONTAINER = 'kb-images';

/** Calls Azure AI Vision Read API to extract text from an image buffer. */
async function runOcr(imageBuffer: Buffer): Promise<string> {
  const endpoint = env.AZURE_VISION_ENDPOINT;
  const key = env.AZURE_VISION_KEY;
  if (endpoint === undefined || key === undefined) return '';

  const analyseUrl = `${endpoint}/vision/v3.2/read/analyze`;
  const submitResponse = await fetch(analyseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Ocp-Apim-Subscription-Key': key,
    },
    body: imageBuffer as unknown as BodyInit,
  });

  if (!submitResponse.ok) {
    throw new BlobStorageError('ocr-submit', `Vision API submit failed: ${submitResponse.status.toString()}`);
  }

  const operationUrl = submitResponse.headers.get('Operation-Location');
  if (operationUrl === null) throw new BlobStorageError('ocr-submit', 'Vision API returned no operation URL');

  // Poll until complete (max 10 attempts, 1s apart)
  for (let i = 0; i < OCR_MAX_POLLS; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, OCR_POLL_INTERVAL_MS));
    const pollResponse = await fetch(operationUrl, {
      headers: { 'Ocp-Apim-Subscription-Key': key },
    });
    const pollBody = (await pollResponse.json()) as {
      status: string;
      analyzeResult?: { readResults: Array<{ lines: Array<{ text: string }> }> };
    };

    if (pollBody.status === 'succeeded') {
      const lines = pollBody.analyzeResult?.readResults.flatMap((r) =>
        r.lines.map((l) => l.text),
      ) ?? [];
      return lines.join('\n');
    }
    if (pollBody.status === 'failed') break;
  }
  return '';
}

// ── POST /api/images ───────────────────────────────────────────────────────────
// Expects raw binary body with Content-Type: image/*

router.post('/', (req: Request, res: Response, next: NextFunction): void => {
  (async (): Promise<void> => {
    const db = getDb();

    // express.raw() puts the buffer directly on req.body
    const rawBody = req.body instanceof Buffer ? req.body : Buffer.from([]);

    if (rawBody.length === 0) {
      throw new ValidationError('image body is empty', { image: 'required' });
    }

    // Parse caption from query string (multipart form handling is minimal here)
    const caption = typeof req.query['caption'] === 'string' ? req.query['caption'] : '';
    const contentType = (req.headers['content-type'] ?? 'application/octet-stream') as string;

    // Generate a UUID for both blob name and DB primary key
    const imageId = randomUUID();
    const blobName = imageId;

    // Build blob client from account name + key directly (no connection string).
    const accountName = env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = env.AZURE_STORAGE_ACCOUNT_KEY;
    if (accountName === undefined || accountKey === undefined) {
      throw new BlobStorageError('config', 'AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY must be set');
    }
    const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
    const service = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, sharedKeyCredential);
    console.log('[images] Built blob service client');
    const container = service.getContainerClient(KB_IMAGES_CONTAINER);
    const blockBlob = container.getBlockBlobClient(blobName);
    console.log('[images] Got block blob client, url:', blockBlob.url.split('?')[0]);

    const uploadAbort = AbortSignal.timeout(BLOB_UPLOAD_TIMEOUT_MS);
    await blockBlob.uploadData(rawBody, {
      blobHTTPHeaders: { blobContentType: contentType },
      abortSignal: uploadAbort,
    });
    console.log('[images] Upload complete');

    // Generate a long-lived SAS URL so the image is accessible in the browser
    // without the container being public.
    const expiresOn = new Date();
    expiresOn.setFullYear(expiresOn.getFullYear() + IMAGE_SAS_EXPIRY_YEARS);
    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: KB_IMAGES_CONTAINER,
        blobName,
        permissions: BlobSASPermissions.parse('r'),
        expiresOn,
      },
      sharedKeyCredential,
    ).toString();
    const blobUrl = `${blockBlob.url}?${sasToken}`;

    // Run vision analysis (GPT-4V) and OCR in parallel
    const [visionAnalysis, ocrText] = await Promise.all([
      analyzeImageWithVision(rawBody as Buffer<ArrayBufferLike>, contentType).catch((err) => {
        console.error('[images] Vision analysis failed, continuing with OCR only:', err);
        return '';
      }),
      runOcr(rawBody as Buffer<ArrayBufferLike>),
    ]);

    console.log('[images] Vision analysis:', visionAnalysis.slice(0, 100), '...');
    console.log('[images] OCR text:', ocrText.slice(0, 100), '...');

    // Persist to database
    const result = await db.query<{
      id: string;
      blob_url: string;
      ocr_text: string;
      vision_analysis: string;
      caption: string;
      created_at: string;
      tags: string[];
      linked_items: string[];
    }>(
      `INSERT INTO kb_images (id, blob_url, ocr_text, vision_analysis, caption)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, blob_url, ocr_text, vision_analysis, caption, created_at, tags, linked_items`,
      [imageId, blobUrl, ocrText, visionAnalysis, caption],
    );

    const row = result.rows[0];
    if (row === undefined) throw new Error('Insert returned no rows');

    const image: KnowledgeImage = {
      id: row.id,
      blobUrl: row.blob_url,
      ...(row.ocr_text !== '' && { ocrText: row.ocr_text }),
      ...(row.vision_analysis !== '' && { visionAnalysis: row.vision_analysis }),
      ...(row.caption !== '' && { caption: row.caption }),
      createdAt: row.created_at,
      tags: row.tags,
      linkedItems: row.linked_items,
    };

    const body: ApiSuccess<{ id: string; blobUrl: string; ocrText?: string; visionAnalysis?: string }> = {
      success: true,
      data: {
        id: image.id,
        blobUrl: image.blobUrl,
        ...(image.ocrText !== undefined && { ocrText: image.ocrText }),
        ...(image.visionAnalysis !== undefined && { visionAnalysis: image.visionAnalysis }),
      },
    };
    res.status(HTTP_STATUS.CREATED).json(body);
  })().catch((err: unknown) => {
    console.error('[images] POST handler error:', err);
    next(err);
  });
});

// ── POST /api/images/lookup ─────────────────────────────────────────────────────
// Given the blob URLs embedded in a note/canvas (as returned by POST /api/images),
// return each image's stored vision analysis / OCR text so the AI chat can be
// primed with what's actually in the picture, not just its filename/URL.
// Note: `/api/images` is mounted behind `express.raw({ type: '*/*' })` (see
// app.ts), so even this JSON endpoint arrives as a raw Buffer — parse it by hand.

router.post('/lookup', (req: Request, res: Response, next: NextFunction): void => {
  (async (): Promise<void> => {
    const db = getDb();

    const rawBody = req.body instanceof Buffer ? req.body : Buffer.from([]);
    let parsed: unknown;
    try {
      parsed = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf-8')) : {};
    } catch {
      throw new ValidationError('invalid JSON body', { body: 'must be valid JSON' });
    }

    const blobUrls = (parsed as { blobUrls?: unknown }).blobUrls;
    if (!Array.isArray(blobUrls) || blobUrls.some((u) => typeof u !== 'string')) {
      throw new ValidationError('blobUrls must be an array of strings', { blobUrls: 'required' });
    }

    // The blob name (== kb_images.id) is the last path segment before the
    // SAS query string, e.g. https://acct.blob.core.windows.net/kb-images/<id>?sv=...
    const ids = (blobUrls as string[])
      .map((url) => {
        const withoutQuery = url.split('?')[0] ?? '';
        const segments = withoutQuery.split('/');
        return segments[segments.length - 1] ?? '';
      })
      .filter((id) => id !== '');

    if (ids.length === 0) {
      res.status(HTTP_STATUS.OK).json({ success: true, data: { items: [] } });
      return;
    }

    const result = await db.query<{
      id: string;
      ocr_text: string;
      vision_analysis: string;
      caption: string;
    }>(
      `SELECT id, ocr_text, vision_analysis, caption FROM kb_images WHERE id = ANY($1)`,
      [ids],
    );

    const items = result.rows.map((row) => ({
      id: row.id,
      ...(row.ocr_text !== '' && { ocrText: row.ocr_text }),
      ...(row.vision_analysis !== '' && { visionAnalysis: row.vision_analysis }),
      ...(row.caption !== '' && { caption: row.caption }),
    }));

    const body: ApiSuccess<{ items: typeof items }> = { success: true, data: { items } };
    res.status(HTTP_STATUS.OK).json(body);
  })().catch((err: unknown) => {
    console.error('[images] POST /lookup handler error:', err);
    next(err);
  });
});

// ── GET /api/images ────────────────────────────────────────────────────────────

router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  (async (): Promise<void> => {
    const db = getDb();
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(String(req.query['pageSize'] ?? String(DEFAULT_PAGE_SIZE)), 10)),
    );
    const offset = (page - 1) * pageSize;

    const [rowsResult, countResult] = await Promise.all([
      db.query<{
        id: string;
        blob_url: string;
        ocr_text: string;
        vision_analysis: string;
        caption: string;
        created_at: string;
        tags: string[];
        linked_items: string[];
      }>(
        `SELECT id, blob_url, ocr_text, vision_analysis, caption, created_at, tags, linked_items
         FROM kb_images
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      ),
      db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM kb_images`),
    ]);

    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);
    const images: KnowledgeImage[] = rowsResult.rows.map((row) => ({
      id: row.id,
      blobUrl: row.blob_url,
      ...(row.ocr_text !== '' && { ocrText: row.ocr_text }),
      ...(row.vision_analysis !== '' && { visionAnalysis: row.vision_analysis }),
      ...(row.caption !== '' && { caption: row.caption }),
      createdAt: row.created_at,
      tags: row.tags,
      linkedItems: row.linked_items,
    }));

    const body: ApiSuccess<PaginatedList<KnowledgeImage>> = {
      success: true,
      data: { items: images, total, page, pageSize, hasMore: offset + images.length < total },
    };
    res.status(HTTP_STATUS.OK).json(body);
  })().catch((err: unknown) => {
    console.error('[images] GET handler error:', err);
    next(err);
  });
});

export { router as imagesRouter };

