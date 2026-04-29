/**
 * Images routes — Change 003
 *
 * POST /api/images   — upload an image, run OCR, store in kb-images blob container
 * GET  /api/images   — paginated list of images
 *
 * Azure AI Vision is used for OCR. If the AZURE_VISION_ENDPOINT env var is not
 * set, OCR is skipped and ocrText is stored as an empty string.
 */

import { Router, type Request, type Response } from 'express';
import { BlobServiceClient, BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { HTTP_STATUS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, RANDOM_ID_RADIX, RANDOM_ID_SLICE_START, RANDOM_ID_SLICE_END, OCR_MAX_POLLS, OCR_POLL_INTERVAL_MS, IMAGE_SAS_EXPIRY_YEARS } from '../config/constants.js';
import { BlobStorageError, ValidationError } from '../types/index.js';
import type { ApiSuccess, PaginatedList, KnowledgeImage } from '../types/index.js';

const router = Router();

const KB_IMAGES_CONTAINER = 'kb-images';

/** Returns a BlobServiceClient using Managed Identity (prod) or conn string (dev). */
function getBlobService(): BlobServiceClient {
  if (env.AZURE_BLOB_ACCOUNT_URL !== undefined) {
    return new BlobServiceClient(env.AZURE_BLOB_ACCOUNT_URL, new DefaultAzureCredential());
  }
  if (env.AZURE_STORAGE_CONNECTION_STRING !== undefined) {
    return BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING);
  }
  throw new BlobStorageError('init', 'No Azure Blob credentials configured');
}

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

router.post('/', (req: Request, res: Response): void => {
  void (async (): Promise<void> => {
    const db = getDb();

    // express.raw() puts the buffer directly on req.body
    const rawBody = req.body instanceof Buffer ? req.body : Buffer.from([]);

    if (rawBody.length === 0) {
      throw new ValidationError('image body is empty', { image: 'required' });
    }

    // Parse caption from query string (multipart form handling is minimal here)
    const caption = typeof req.query['caption'] === 'string' ? req.query['caption'] : '';

    // Generate a deterministic blob name
    const imageId = `img-${Date.now().toString()}-${Math.random().toString(RANDOM_ID_RADIX).slice(RANDOM_ID_SLICE_START, RANDOM_ID_SLICE_END)}`;
    const blobName = `${imageId}`;

    // Upload to Azure Blob Storage
    const service = getBlobService();
    const container = service.getContainerClient(KB_IMAGES_CONTAINER);
    const blockBlob = container.getBlockBlobClient(blobName);
    await blockBlob.uploadData(rawBody, {
      blobHTTPHeaders: { blobContentType: req.headers['content-type'] ?? 'application/octet-stream' },
    });

    // Generate a long-lived SAS URL so the image is accessible in the browser
    // without the container being public. Requires storage account name + key.
    let blobUrl: string;
    const accountName = env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = env.AZURE_STORAGE_ACCOUNT_KEY;
    if (accountName !== undefined && accountKey !== undefined) {
      const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
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
      blobUrl = `${blockBlob.url}?${sasToken}`;
    } else {
      blobUrl = blockBlob.url;
    }

    // Run OCR
    const ocrText = await runOcr(rawBody as Buffer<ArrayBufferLike>);

    // Persist to database
    const result = await db.query<{
      id: string;
      blob_url: string;
      ocr_text: string;
      caption: string;
      created_at: string;
      tags: string[];
      linked_items: string[];
    }>(
      `INSERT INTO kb_images (id, blob_url, ocr_text, caption)
       VALUES ($1, $2, $3, $4)
       RETURNING id, blob_url, ocr_text, caption, created_at, tags, linked_items`,
      [imageId, blobUrl, ocrText, caption],
    );

    const row = result.rows[0];
    if (row === undefined) throw new Error('Insert returned no rows');

    const image: KnowledgeImage = {
      id: row.id,
      blobUrl: row.blob_url,
      ...(row.ocr_text !== '' && { ocrText: row.ocr_text }),
      ...(row.caption !== '' && { caption: row.caption }),
      createdAt: row.created_at,
      tags: row.tags,
      linkedItems: row.linked_items,
    };

    const body: ApiSuccess<{ id: string; blobUrl: string; ocrText?: string }> = {
      success: true,
      data: {
        id: image.id,
        blobUrl: image.blobUrl,
        ...(image.ocrText !== undefined && { ocrText: image.ocrText }),
      },
    };
    res.status(HTTP_STATUS.CREATED).json(body);
  })();
});

// ── GET /api/images ────────────────────────────────────────────────────────────

router.get('/', (req: Request, res: Response): void => {
  void (async (): Promise<void> => {
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
        caption: string;
        created_at: string;
        tags: string[];
        linked_items: string[];
      }>(
        `SELECT id, blob_url, ocr_text, caption, created_at, tags, linked_items
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
  })();
});

export { router as imagesRouter };
