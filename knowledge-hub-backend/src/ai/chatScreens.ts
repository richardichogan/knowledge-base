/**
 * ai/chatScreens.ts — screenshots kept with a chat (the Screens panel).
 * Each is stored privately in blob storage, read once (the read is reused in
 * later turns), can be placed in an ordered journey, and can carry a
 * marked-up copy with a note. Reviews send the images themselves to the
 * vision model (journey review, or a close look at the marked areas).
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { BlobServiceClient, StorageSharedKeyCredential, type ContainerClient } from '@azure/storage-blob';
import { env } from '../config/env.js';
import { analyzeImageWithVision, reviewScreensWithVision, type ScreenImage } from '../services/visionAnalyzer.js';

const CONTAINER = 'chat-screens';

export interface ChatScreen {
  id: string;
  sessionId: string;
  name: string;
  contentType: string;
  position: number;
  inJourney: boolean;
  hasReading: boolean;
  annotated: boolean;
  annotationNote: string | null;
  createdAt: string;
}

interface ScreenRow {
  id: string;
  session_id: string;
  blob_name: string;
  content_type: string;
  name: string;
  position: number;
  in_journey: boolean;
  reading: string | null;
  annotated_blob_name: string | null;
  annotation_note: string | null;
  created_at: Date;
}

function toScreen(r: ScreenRow): ChatScreen {
  return {
    id: r.id, sessionId: r.session_id, name: r.name, contentType: r.content_type, position: r.position,
    inJourney: r.in_journey, hasReading: (r.reading ?? '') !== '', annotated: r.annotated_blob_name !== null,
    annotationNote: r.annotation_note, createdAt: r.created_at.toISOString(),
  };
}

const COLUMNS = `id::text, session_id::text, blob_name, content_type, name, position, in_journey, reading,
                 annotated_blob_name, annotation_note, created_at`;

let containerPromise: Promise<ContainerClient> | null = null;

function container(): Promise<ContainerClient> {
  containerPromise ??= (async () => {
    const accountName = env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = env.AZURE_STORAGE_ACCOUNT_KEY;
    if (!accountName || !accountKey) throw new Error('Blob storage is not configured');
    const service = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, new StorageSharedKeyCredential(accountName, accountKey));
    const client = service.getContainerClient(CONTAINER);
    await client.createIfNotExists(); // private: no public access
    return client;
  })().catch((err: unknown) => { containerPromise = null; throw err; });
  return containerPromise;
}

async function uploadBlob(buffer: Buffer, contentType: string): Promise<string> {
  const name = randomUUID();
  await (await container()).getBlockBlobClient(name).uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType } });
  return name;
}

export async function downloadBlob(name: string): Promise<Buffer> {
  return (await container()).getBlockBlobClient(name).downloadToBuffer();
}

async function deleteBlobs(names: Array<string | null>): Promise<void> {
  const client = await container();
  await Promise.all(names.filter((n): n is string => n !== null).map((n) => client.getBlockBlobClient(n).deleteIfExists().catch(() => undefined)));
}

async function getRow(db: Pool, id: string): Promise<ScreenRow | null> {
  const { rows } = await db.query<ScreenRow>(`SELECT ${COLUMNS} FROM chat_screens WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Stores a screenshot in a chat and reads it (a detailed design read for
 * Demo Designer). Returns the screen and its read.
 */
export async function addScreen(
  db: Pool,
  sessionId: string,
  input: { buffer: Buffer; contentType: string; name: string; persona?: string | undefined; question?: string | undefined },
): Promise<{ screen: ChatScreen; reading: string }> {
  const blobName = await uploadBlob(input.buffer, input.contentType);
  const reading = await analyzeImageWithVision(input.buffer, input.contentType, input.question, { designReview: input.persona === 'demo_designer' });
  await db.query(`INSERT INTO ai_chat_sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [sessionId]);
  const { rows } = await db.query<ScreenRow>(
    `INSERT INTO chat_screens (session_id, blob_name, content_type, name, position, reading)
     VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(position), 0) + 1 FROM chat_screens WHERE session_id = $1), $5)
     RETURNING ${COLUMNS}`,
    [sessionId, blobName, input.contentType, input.name.trim() || 'Screen', reading],
  );
  return { screen: toScreen(rows[0]!), reading };
}

export async function listScreens(db: Pool, sessionId: string): Promise<ChatScreen[]> {
  const { rows } = await db.query<ScreenRow>(`SELECT ${COLUMNS} FROM chat_screens WHERE session_id = $1 ORDER BY position, created_at`, [sessionId]);
  return rows.map(toScreen);
}

/** The image (or its marked-up copy) for display. */
export async function getScreenImage(db: Pool, id: string, annotated: boolean): Promise<{ buffer: Buffer; contentType: string } | null> {
  const row = await getRow(db, id);
  if (row === null) return null;
  if (annotated && row.annotated_blob_name !== null) return { buffer: await downloadBlob(row.annotated_blob_name), contentType: 'image/png' };
  return { buffer: await downloadBlob(row.blob_name), contentType: row.content_type };
}

export async function updateScreen(db: Pool, id: string, patch: { name?: string | undefined; inJourney?: boolean | undefined }): Promise<void> {
  await db.query(
    `UPDATE chat_screens SET name = COALESCE($2, name), in_journey = COALESCE($3, in_journey) WHERE id = $1`,
    [id, patch.name?.trim() || null, patch.inJourney ?? null],
  );
}

/** Sets the journey order: ids in the order given. */
export async function reorderScreens(db: Pool, sessionId: string, ids: string[]): Promise<void> {
  await db.query(
    `UPDATE chat_screens s SET position = o.ord
     FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ord)
     WHERE s.id = o.id AND s.session_id = $1`,
    [sessionId, ids],
  );
}

/** Saves a marked-up copy (PNG with the boxes drawn on) and the note about it. */
export async function setAnnotation(db: Pool, id: string, png: Buffer, note: string): Promise<void> {
  const row = await getRow(db, id);
  if (row === null) throw new Error('Screen not found');
  const name = await uploadBlob(png, 'image/png');
  await db.query(`UPDATE chat_screens SET annotated_blob_name = $2, annotation_note = $3 WHERE id = $1`, [id, name, note.trim() || null]);
  await deleteBlobs([row.annotated_blob_name]);
}

export async function clearAnnotation(db: Pool, id: string): Promise<void> {
  const row = await getRow(db, id);
  if (row === null) return;
  await db.query(`UPDATE chat_screens SET annotated_blob_name = NULL, annotation_note = NULL WHERE id = $1`, [id]);
  await deleteBlobs([row.annotated_blob_name]);
}

export async function deleteScreen(db: Pool, id: string): Promise<void> {
  const row = await getRow(db, id);
  if (row === null) return;
  await db.query(`DELETE FROM chat_screens WHERE id = $1`, [id]);
  await deleteBlobs([row.blob_name, row.annotated_blob_name]);
}

/** Removes a chat's images from storage (call before deleting the chat; rows cascade). */
export async function deleteSessionScreenBlobs(db: Pool, sessionId: string): Promise<void> {
  const { rows } = await db.query<{ blob_name: string; annotated_blob_name: string | null }>(
    `SELECT blob_name, annotated_blob_name FROM chat_screens WHERE session_id = $1`,
    [sessionId],
  );
  if (rows.length === 0) return;
  await deleteBlobs(rows.flatMap((r) => [r.blob_name, r.annotated_blob_name]));
}

const SCREENS_BLOCK_BUDGET = 12_000;

/** The chat's screens for Athena's context: names, journey order, notes and (trimmed) reads. */
export async function buildScreensBlock(db: Pool, sessionId: string): Promise<string> {
  const { rows } = await db.query<ScreenRow>(`SELECT ${COLUMNS} FROM chat_screens WHERE session_id = $1 ORDER BY position, created_at`, [sessionId]);
  if (rows.length === 0) return '';
  const per = Math.max(600, Math.floor(SCREENS_BLOCK_BUDGET / rows.length));
  const journey = rows.filter((r) => r.in_journey).map((r) => r.name);
  return [
    '## Screens in this chat (the Screens panel — screenshots kept with this chat, read once)',
    journey.length > 1 ? `Journey order: ${journey.join(' → ')}. He can run "Review this journey" to have them looked at together.` : '',
    ...rows.map((r, i) => {
      const reading = (r.reading ?? '').trim();
      return [
        `### ${(i + 1).toString()}. ${r.name}${r.in_journey ? '' : ' (not in the journey)'}`,
        r.annotation_note !== null ? `He marked areas on it: ${r.annotation_note}` : '',
        reading.length > per ? `${reading.slice(0, per)}…` : reading,
      ].filter(Boolean).join('\n');
    }),
  ].filter(Boolean).join('\n\n');
}

/**
 * Looks at screens together with the vision model: the whole journey (in
 * order, marked-up copies where present), or a close look at the given
 * screens' marked areas. Returns the review text and a short title.
 */
export async function reviewScreens(
  db: Pool,
  sessionId: string,
  mode: 'journey' | 'focus',
  screenIds: string[] | undefined,
  question: string,
): Promise<{ title: string; review: string } | null> {
  const { rows } = await db.query<ScreenRow>(`SELECT ${COLUMNS} FROM chat_screens WHERE session_id = $1 ORDER BY position, created_at`, [sessionId]);
  const chosen = mode === 'journey'
    ? rows.filter((r) => r.in_journey)
    : rows.filter((r) => screenIds?.includes(r.id) === true);
  if (chosen.length === 0) return null;
  const images: ScreenImage[] = await Promise.all(chosen.map(async (r) => ({
    buffer: await downloadBlob(r.annotated_blob_name ?? r.blob_name),
    mimeType: r.annotated_blob_name !== null ? 'image/png' : r.content_type,
    label: r.name,
    note: r.annotation_note ?? undefined,
  })));
  const review = await reviewScreensWithVision(images, mode, question);
  const title = mode === 'journey' ? `Journey: ${chosen.map((r) => r.name).join(' → ')}` : `Marked areas on ${chosen.map((r) => r.name).join(', ')}`;
  if (review !== '') return { title, review };
  // Vision step unavailable: fall back to the stored reads.
  return {
    title,
    review: chosen.map((r, i) => `Screen ${(i + 1).toString()}: ${r.name}${r.annotation_note !== null ? ` (his note: ${r.annotation_note})` : ''}\n${r.reading ?? ''}`).join('\n\n'),
  };
}
