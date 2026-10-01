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
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { listOutputs, getOutput, saveOutputVersion, renameOutput, deleteOutput } from '../ai/chatOutputs.js';
import { listDecisions, addDecision, updateDecision, deleteDecision, isTrackingDecisions, setTrackingDecisions, type DecisionStatus } from '../ai/chatDecisions.js';
import { getSessionProjectId } from '../ai/chatSessionStore.js';
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

export { router as chatPanelRouter };
