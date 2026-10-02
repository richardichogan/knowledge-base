/**
 * ai/chatFiles.ts — spreadsheets attached in a chat, and the "calculator":
 * each file is uploaded once to the reasoning endpoint's file store and
 * loaded into the model's code tool (code_interpreter, Responses API), so
 * totals, filters and comparisons are computed rather than estimated.
 */
import type { Pool } from 'pg';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { env } from '../config/env.js';

const DOCUMENTS_CONTAINER = 'kb-documents';
export const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'csv']);

export interface ChatFile {
  id: string;
  filename: string;
  blobPath: string;
  contentType: string;
  azureFileId: string | null;
}

export async function addChatFile(
  db: Pool,
  sessionId: string,
  file: { contentItemId: string; filename: string; blobPath: string; contentType: string },
): Promise<void> {
  await db.query(`INSERT INTO ai_chat_sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [sessionId]);
  await db.query(
    `INSERT INTO chat_files (session_id, content_item_id, filename, blob_path, content_type) VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, file.contentItemId, file.filename, file.blobPath, file.contentType],
  );
}

export async function listChatFiles(db: Pool, sessionId: string): Promise<ChatFile[]> {
  const { rows } = await db.query<{ id: string; filename: string; blob_path: string; content_type: string; azure_file_id: string | null }>(
    `SELECT id::text, filename, blob_path, content_type, azure_file_id FROM chat_files WHERE session_id = $1 ORDER BY created_at`,
    [sessionId],
  );
  return rows.map((r) => ({ id: r.id, filename: r.filename, blobPath: r.blob_path, contentType: r.content_type, azureFileId: r.azure_file_id }));
}

function filesEndpoint(): { url: string; key: string } | null {
  if (!env.AZURE_OPENAI_ENDPOINT_GPT54 || !env.AZURE_OPENAI_API_KEY_GPT54) return null;
  return { url: `${env.AZURE_OPENAI_ENDPOINT_GPT54}/openai/v1/files`, key: env.AZURE_OPENAI_API_KEY_GPT54 };
}

async function downloadDocument(blobPath: string): Promise<Buffer> {
  const accountName = env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = env.AZURE_STORAGE_ACCOUNT_KEY;
  if (!accountName || !accountKey) throw new Error('Blob storage is not configured');
  const service = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, new StorageSharedKeyCredential(accountName, accountKey));
  return service.getContainerClient(DOCUMENTS_CONTAINER).getBlockBlobClient(blobPath).downloadToBuffer();
}

/**
 * The model-side file ids for the chat's spreadsheets, uploading any not yet
 * uploaded. Files that can't be uploaded are skipped (the turn still runs,
 * reading the extracted text instead).
 */
export async function ensureModelFiles(db: Pool, files: ChatFile[]): Promise<string[]> {
  const endpoint = filesEndpoint();
  if (endpoint === null) return [];
  const ids: string[] = [];
  for (const f of files) {
    if (f.azureFileId !== null) {
      ids.push(f.azureFileId);
      continue;
    }
    try {
      const form = new FormData();
      form.append('purpose', 'assistants');
      form.append('file', new Blob([new Uint8Array(await downloadDocument(f.blobPath))], { type: f.contentType || 'application/octet-stream' }), f.filename);
      const response = await fetch(endpoint.url, { method: 'POST', headers: { 'api-key': endpoint.key }, body: form, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`${response.status.toString()} ${await response.text()}`);
      const { id } = (await response.json()) as { id: string };
      await db.query(`UPDATE chat_files SET azure_file_id = $2 WHERE id = $1`, [f.id, id]);
      ids.push(id);
    } catch (err) {
      console.error(`[chat-files] could not load ${f.filename} for the calculator:`, err);
    }
  }
  return ids;
}

/** Removes a chat's files from the model's file store (call before deleting the chat). */
export async function deleteSessionModelFiles(db: Pool, sessionId: string): Promise<void> {
  const endpoint = filesEndpoint();
  if (endpoint === null) return;
  for (const f of await listChatFiles(db, sessionId)) {
    if (f.azureFileId === null) continue;
    await fetch(`${endpoint.url}/${f.azureFileId}`, { method: 'DELETE', headers: { 'api-key': endpoint.key } }).catch(() => undefined);
  }
}

/** Tells Athena the spreadsheets are loaded in her code tool and to calculate, not estimate. */
export function spreadsheetsBlock(filenames: string[]): string {
  if (filenames.length === 0) return '';
  return [
    '## Spreadsheets in this chat — calculator available',
    `These files are loaded in your Python tool (code_interpreter) under /mnt/data — each file name there starts with a file id: ${filenames.join(', ')}.`,
    'For any number that comes from them — totals, averages, counts, filters, comparisons, top/bottom N, growth, ' +
      'anything across more than a handful of cells — load the file with pandas and compute it. Never estimate or ' +
      'add up in your head. Check the header row and sheet names first. Say briefly what you calculated (e.g. ' +
      '"sum of column D on Sales, rows 2–481"), and show results as a table when there are several.',
  ].join('\n');
}
