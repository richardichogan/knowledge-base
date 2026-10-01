/**
 * routes/chatPanel.ts — the chat side panel: Outputs (versioned deliverables)
 * and Decisions (decided / open points). Mounted under /api/ai.
 *
 * GET    /session/:sessionId/outputs          list
 * GET    /outputs/:outputId                   one output with all versions
 * POST   /outputs/:outputId/versions          { content, note? } — the user's edit
 * PATCH  /outputs/:outputId                   { title }
 * DELETE /outputs/:outputId
 * POST   /outputs/:outputId/save-to-think     { version? } — a Think note from it
 * GET    /session/:sessionId/decisions        { tracking, decisions }
 * POST   /session/:sessionId/decisions        { status, text }
 * PUT    /session/:sessionId/decision-tracking { enabled: boolean | null }
 * PATCH  /decisions/:decisionId               { status?, text? }
 * DELETE /decisions/:decisionId
 * POST   /session/:sessionId/screens          raw image; ?name=&persona=&question= — store + read
 * GET    /session/:sessionId/screens          list
 * PUT    /session/:sessionId/screens/order    { ids } — journey order
 * GET    /screens/:screenId/image             ?annotated=1 for the marked-up copy
 * PATCH  /screens/:screenId                   { name?, inJourney? }
 * PUT    /screens/:screenId/annotation        raw PNG; ?note= — the marked-up copy
 * DELETE /screens/:screenId/annotation
 * DELETE /screens/:screenId
 * GET    /models                              models offered for "Ask another model"
 * POST   /session/:sessionId/messages/:messageId/alternates  { model } — re-answer in the background → { turnId }
 * GET    /session/:sessionId/alternates       alternatives, by reply
 * POST   /alternates/:alternateId/use         swap it into the chat
 * GET    /session/:sessionId/exclusions       items not to use in this chat
 * POST   /session/:sessionId/exclusions       { id, kind, title, url? } — "Don't use this"
 * DELETE /session/:sessionId/exclusions/:sourceId
 */
import express, { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { listOutputs, getOutput, saveOutputVersion, renameOutput, deleteOutput } from '../ai/chatOutputs.js';
import { listDecisions, addDecision, updateDecision, deleteDecision, isTrackingDecisions, setTrackingDecisions, type DecisionStatus } from '../ai/chatDecisions.js';
import { getSessionProjectId } from '../ai/chatSessionStore.js';
import { randomUUID } from 'node:crypto';
import { handleConversationTurn } from '../ai/conversationService.js';
import { getTurnForAlternate, replaceMessageContent } from '../ai/chatSessionStore.js';
import { startTurnJob } from '../ai/turnJobs.js';
import { MODEL_CHOICES, findModelChoice } from '../ai/modelChoices.js';
import { AI_BACKGROUND_TURN_BUDGET_MS } from '../config/constants.js';
import { getExcludedSources, excludeSource, includeSource } from '../ai/contextUsage.js';
import { addScreen, listScreens, getScreenImage, updateScreen, reorderScreens, setAnnotation, clearAnnotation, deleteScreen } from '../ai/chatScreens.js';
import { textToBlocks } from '../ai/chatTools.js';
import { createNoteRecord } from './notes.js';
import { env } from '../config/env.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError, NotFoundError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';

const router = Router();

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => { handler(req, res).catch(next); };
}
function ok<T>(res: Response, data: T, status: number = HTTP_STATUS.OK): void {
  const body: ApiSuccess<T> = { success: true, data };
  res.status(status).json(body);
}
function param(req: Request, name: string): string {
  return req.params[name] ?? '';
}
function isStatus(v: unknown): v is DecisionStatus {
  return v === 'decided' || v === 'open';
}

// ── Outputs ───────────────────────────────────────────────────────────────────

router.get('/session/:sessionId/outputs', route(async (req, res) => {
  ok(res, await listOutputs(getDb(), param(req, 'sessionId')));
}));

router.get('/outputs/:outputId', route(async (req, res) => {
  const output = await getOutput(getDb(), param(req, 'outputId'));
  if (output === null) throw new NotFoundError('Output');
  ok(res, output);
}));

router.post('/outputs/:outputId/versions', route(async (req, res) => {
  const { content, note } = req.body as { content?: unknown; note?: unknown };
  if (typeof content !== 'string' || content.trim() === '') throw new ValidationError('content required', { content: 'required' });
  const db = getDb();
  const output = await getOutput(db, param(req, 'outputId'));
  if (output === null) throw new NotFoundError('Output');
  const saved = await saveOutputVersion(db, output.sessionId, {
    outputId: output.id, content, author: 'user', note: typeof note === 'string' ? note : 'Edited by you',
  });
  ok(res, saved, HTTP_STATUS.CREATED);
}));

router.patch('/outputs/:outputId', route(async (req, res) => {
  const { title } = req.body as { title?: unknown };
  if (typeof title !== 'string' || title.trim() === '') throw new ValidationError('title required', { title: 'required' });
  await renameOutput(getDb(), param(req, 'outputId'), title);
  ok(res, { renamed: true });
}));

router.delete('/outputs/:outputId', route(async (req, res) => {
  await deleteOutput(getDb(), param(req, 'outputId'));
  ok(res, { deleted: true });
}));

router.post('/outputs/:outputId/save-to-think', route(async (req, res) => {
  const db = getDb();
  const output = await getOutput(db, param(req, 'outputId'));
  if (output === null) throw new NotFoundError('Output');
  const wanted = (req.body as { version?: unknown }).version;
  const version = output.versions.find((v) => v.version === wanted) ?? output.versions[output.versions.length - 1];
  if (version === undefined) throw new ValidationError('output has no content', { output: 'empty' });
  const markdown = output.format === 'text' ? `\`\`\`text\n${version.content}\n\`\`\`` : version.content;
  const blocks = textToBlocks(markdown);
  const projectId = await getSessionProjectId(db, output.sessionId);
  const note = await createNoteRecord(db, {
    content: JSON.stringify({ title: output.title, contentType: 'note', contentJson: JSON.stringify(blocks) }),
    tags: ['athena-output'],
    ...(projectId !== null && { projectId }),
  });
  ok(res, { noteId: note.id, title: output.title, url: `${env.FRONTEND_BASE_URL}/think?noteId=${note.id}` }, HTTP_STATUS.CREATED);
}));

// ── Decisions ─────────────────────────────────────────────────────────────────

router.get('/session/:sessionId/decisions', route(async (req, res) => {
  const db = getDb();
  const sessionId = param(req, 'sessionId');
  const [tracking, decisions] = await Promise.all([isTrackingDecisions(db, sessionId), listDecisions(db, sessionId)]);
  ok(res, { tracking, decisions });
}));

router.post('/session/:sessionId/decisions', route(async (req, res) => {
  const { status, text } = req.body as { status?: unknown; text?: unknown };
  if (!isStatus(status)) throw new ValidationError('status must be decided or open', { status: 'invalid' });
  if (typeof text !== 'string' || text.trim() === '') throw new ValidationError('text required', { text: 'required' });
  ok(res, await addDecision(getDb(), param(req, 'sessionId'), status, text, 'user'), HTTP_STATUS.CREATED);
}));

router.put('/session/:sessionId/decision-tracking', route(async (req, res) => {
  const { enabled } = req.body as { enabled?: unknown };
  if (enabled !== null && typeof enabled !== 'boolean') throw new ValidationError('enabled must be true, false or null', { enabled: 'invalid' });
  const db = getDb();
  await setTrackingDecisions(db, param(req, 'sessionId'), enabled);
  ok(res, await isTrackingDecisions(db, param(req, 'sessionId')));
}));

router.patch('/decisions/:decisionId', route(async (req, res) => {
  const { status, text } = req.body as { status?: unknown; text?: unknown };
  if (status !== undefined && !isStatus(status)) throw new ValidationError('status must be decided or open', { status: 'invalid' });
  await updateDecision(getDb(), param(req, 'decisionId'), {
    status: isStatus(status) ? status : undefined,
    text: typeof text === 'string' ? text : undefined,
  });
  ok(res, { updated: true });
}));

router.delete('/decisions/:decisionId', route(async (req, res) => {
  await deleteDecision(getDb(), param(req, 'decisionId'));
  ok(res, { deleted: true });
}));

// ── Screens ───────────────────────────────────────────────────────────────────

const SCREEN_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const rawImage = express.raw({ type: 'image/*', limit: '20mb' });
function query(req: Request, name: string): string {
  const v = req.query[name];
  return typeof v === 'string' ? v : '';
}

router.post('/session/:sessionId/screens', rawImage, route(async (req, res) => {
  const body = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (body.length === 0) throw new ValidationError('image body is empty', { image: 'required' });
  if (!SCREEN_TYPES.has(contentType)) throw new ValidationError('screenshot must be PNG, JPEG, WebP or GIF', { image: 'invalid-type' });
  const result = await addScreen(getDb(), param(req, 'sessionId'), {
    buffer: body, contentType, name: query(req, 'name') || 'Screen', persona: query(req, 'persona'), question: query(req, 'question'),
  });
  if (result.reading.trim() === '') throw new ValidationError('the screenshot could not be read', { image: 'analysis-failed' });
  ok(res, result, HTTP_STATUS.CREATED);
}));

router.get('/session/:sessionId/screens', route(async (req, res) => {
  ok(res, await listScreens(getDb(), param(req, 'sessionId')));
}));

router.put('/session/:sessionId/screens/order', route(async (req, res) => {
  const { ids } = req.body as { ids?: unknown };
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new ValidationError('ids must be a list of screen ids', { ids: 'invalid' });
  await reorderScreens(getDb(), param(req, 'sessionId'), ids as string[]);
  ok(res, { reordered: true });
}));

router.get('/screens/:screenId/image', route(async (req, res) => {
  const image = await getScreenImage(getDb(), param(req, 'screenId'), query(req, 'annotated') === '1');
  if (image === null) throw new NotFoundError('Screen');
  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.status(HTTP_STATUS.OK).send(image.buffer);
}));

router.patch('/screens/:screenId', route(async (req, res) => {
  const { name, inJourney } = req.body as { name?: unknown; inJourney?: unknown };
  await updateScreen(getDb(), param(req, 'screenId'), {
    name: typeof name === 'string' ? name : undefined,
    inJourney: typeof inJourney === 'boolean' ? inJourney : undefined,
  });
  ok(res, { updated: true });
}));

router.put('/screens/:screenId/annotation', express.raw({ type: 'image/png', limit: '20mb' }), route(async (req, res) => {
  const body = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
  if (body.length === 0) throw new ValidationError('marked-up image is empty', { image: 'required' });
  await setAnnotation(getDb(), param(req, 'screenId'), body, query(req, 'note'));
  ok(res, { saved: true });
}));

router.delete('/screens/:screenId/annotation', route(async (req, res) => {
  await clearAnnotation(getDb(), param(req, 'screenId'));
  ok(res, { cleared: true });
}));

router.delete('/screens/:screenId', route(async (req, res) => {
  await deleteScreen(getDb(), param(req, 'screenId'));
  ok(res, { deleted: true });
}));

// ── Ask another model ─────────────────────────────────────────────────────────

router.get('/models', route(async (_req, res) => {
  ok(res, MODEL_CHOICES.map((c) => ({ id: c.id, label: c.label })));
}));

router.post('/session/:sessionId/messages/:messageId/alternates', route(async (req, res) => {
  const choice = findModelChoice(String((req.body as { model?: unknown }).model ?? ''));
  if (choice === undefined) throw new ValidationError('unknown model', { model: 'invalid' });
  const db = getDb();
  const sessionId = param(req, 'sessionId');
  const messageId = param(req, 'messageId');
  const turn = await getTurnForAlternate(db, sessionId, messageId);
  if (turn === null) throw new NotFoundError('Reply');
  const turnId = randomUUID();
  startTurnJob(
    turnId, sessionId, turn.userMessage,
    async (hooks) => {
      const reply = await handleConversationTurn(
        db, turn.history, turn.userMessage, choice.model, turn.persona, sessionId, undefined, undefined, {},
        { ...hooks, budgetMs: AI_BACKGROUND_TURN_BUDGET_MS, readOnlyTools: true, ...(choice.route !== undefined && { modelRoute: choice.route }) },
      );
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO chat_alternates (session_id, message_id, model, content) VALUES ($1, $2, $3, $4) RETURNING id::text`,
        [sessionId, messageId, choice.id, reply],
      );
      return { id: rows[0]!.id, messageId, model: choice.id, label: choice.label, content: reply };
    },
    () => { /* nothing to clear */ },
    false,
  );
  ok(res, { turnId });
}));

router.get('/session/:sessionId/alternates', route(async (req, res) => {
  const { rows } = await getDb().query<{ id: string; message_id: string; model: string; content: string; created_at: Date }>(
    `SELECT id::text, message_id::text, model, content, created_at FROM chat_alternates WHERE session_id = $1 ORDER BY created_at`,
    [param(req, 'sessionId')],
  );
  ok(res, rows.map((r) => ({
    id: r.id, messageId: r.message_id, model: r.model,
    label: r.model === 'original' ? 'Original' : findModelChoice(r.model)?.label ?? r.model,
    content: r.content, createdAt: r.created_at.toISOString(),
  })));
}));

router.post('/alternates/:alternateId/use', route(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query<{ session_id: string; message_id: string; content: string; current: string }>(
    `SELECT a.session_id::text, a.message_id::text, a.content, m.content AS current
       FROM chat_alternates a JOIN ai_chat_messages m ON m.id = a.message_id WHERE a.id = $1`,
    [param(req, 'alternateId')],
  );
  const alt = rows[0];
  if (alt === undefined) throw new NotFoundError('Alternative answer');
  // Keep the answer being replaced, then swap; the used one leaves the alternatives.
  await db.query(
    `INSERT INTO chat_alternates (session_id, message_id, model, content) VALUES ($1, $2, 'original', $3)`,
    [alt.session_id, alt.message_id, alt.current],
  );
  await replaceMessageContent(db, alt.message_id, alt.content);
  await db.query(`DELETE FROM chat_alternates WHERE id = $1`, [param(req, 'alternateId')]);
  ok(res, { messageId: alt.message_id, content: alt.content });
}));

// ── "Don't use this" ──────────────────────────────────────────────────────────

router.get('/session/:sessionId/exclusions', route(async (req, res) => {
  ok(res, await getExcludedSources(getDb(), param(req, 'sessionId')));
}));

router.post('/session/:sessionId/exclusions', route(async (req, res) => {
  const { id, kind, title, url } = req.body as { id?: unknown; kind?: unknown; title?: unknown; url?: unknown };
  if (typeof id !== 'string' || id === '') throw new ValidationError('id required', { id: 'required' });
  ok(res, await excludeSource(getDb(), param(req, 'sessionId'), {
    id, kind: typeof kind === 'string' ? kind : 'item', title: typeof title === 'string' ? title : 'Untitled', url: typeof url === 'string' ? url : null,
  }));
}));

router.delete('/session/:sessionId/exclusions/:sourceId', route(async (req, res) => {
  ok(res, await includeSource(getDb(), param(req, 'sessionId'), param(req, 'sourceId')));
}));

export { router as chatPanelRouter };
