/**
 * routes/memories.ts — Athena's learned memory (Memory page) and reply feedback.
 *
 *   GET    /api/memories          → all memories (instructions, examples, profile, suggestions)
 *   POST   /api/memories          → add one manually
 *   PATCH  /api/memories/:id      → edit content/scope, approve (active), pause, dismiss
 *   DELETE /api/memories/:id      → remove
 *   POST   /api/memories/feedback → 👍 saves the reply as an example for its persona;
 *                                   👎 + note drafts a *suggested* instruction to approve
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError, NotFoundError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { createMemory, deleteMemory, listMemories, updateMemory } from '../ai/athenaMemory.js';
import type { AthenaMemory, MemoryScopeType, MemoryStatus } from '../ai/athenaMemory.js';
import { draftInstructionFromFeedback } from '../ai/memorySuggestions.js';

const SCOPES: readonly MemoryScopeType[] = ['global', 'persona', 'project', 'output'];
const STATUSES: readonly MemoryStatus[] = ['active', 'paused', 'suggested', 'dismissed'];
const EXAMPLE_MAX_CHARS = 8_000;

export const memoriesRouter = Router();

memoriesRouter.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const memories = await listMemories(getDb());
      const body: ApiSuccess<{ memories: AthenaMemory[] }> = { success: true, data: { memories } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

memoriesRouter.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { content, scopeType, scopeValue } = req.body as { content?: unknown; scopeType?: unknown; scopeValue?: unknown };
      if (typeof content !== 'string' || content.trim() === '') throw new ValidationError('content required', { content: 'required' });
      const scope = SCOPES.find((s) => s === scopeType) ?? 'global';
      const memory = await createMemory(getDb(), {
        content,
        scopeType: scope,
        scopeValue: typeof scopeValue === 'string' ? scopeValue : null,
        origin: 'manual',
      });
      const body: ApiSuccess<AthenaMemory> = { success: true, data: memory };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) { next(err); }
  })();
});

memoriesRouter.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { id } = req.params as { id: string };
      const b = req.body as { content?: unknown; scopeType?: unknown; scopeValue?: unknown; status?: unknown };
      const patch: Parameters<typeof updateMemory>[2] = {};
      if (typeof b.content === 'string' && b.content.trim() !== '') patch.content = b.content.trim();
      const scope = SCOPES.find((s) => s === b.scopeType);
      if (scope !== undefined) patch.scopeType = scope;
      if ('scopeValue' in b) patch.scopeValue = typeof b.scopeValue === 'string' && b.scopeValue.trim() !== '' ? b.scopeValue.trim() : null;
      const status = STATUSES.find((s) => s === b.status);
      if (status !== undefined) patch.status = status;
      const memory = await updateMemory(getDb(), id, patch);
      if (memory === null) throw new NotFoundError(`Memory ${id} not found`);
      const body: ApiSuccess<AthenaMemory> = { success: true, data: memory };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

memoriesRouter.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { id } = req.params as { id: string };
      await deleteMemory(getDb(), id);
      const body: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

memoriesRouter.post('/feedback', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId, rating, comment, replyContent, persona } = req.body as {
        sessionId?: unknown; rating?: unknown; comment?: unknown; replyContent?: unknown; persona?: unknown;
      };
      if (rating !== 'up' && rating !== 'down') throw new ValidationError('rating must be up or down', { rating: 'up|down' });
      const reply = typeof replyContent === 'string' ? replyContent : '';
      const note = typeof comment === 'string' ? comment.trim() : '';
      const personaId = typeof persona === 'string' && persona !== '' ? persona : 'general';
      const session = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
      const db = getDb();

      let memory: AthenaMemory | null = null;
      if (rating === 'up' && reply.trim() !== '') {
        memory = await createMemory(db, {
          kind: 'example',
          content: reply.slice(0, EXAMPLE_MAX_CHARS),
          scopeType: 'persona',
          scopeValue: personaId,
          origin: 'feedback',
          sourceSessionId: session,
        });
      } else if (rating === 'down' && note !== '') {
        const draft = await draftInstructionFromFeedback(note, reply, personaId);
        memory = await createMemory(db, {
          content: draft.instruction,
          scopeType: draft.scope,
          scopeValue: draft.scopeValue,
          status: 'suggested',
          origin: 'feedback',
          sourceSessionId: session,
          sourceExcerpt: note,
        });
      }

      await db.query(
        `INSERT INTO athena_feedback (session_id, rating, comment, persona, reply_excerpt, memory_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [session, rating, note || null, personaId, reply.slice(0, 1_000) || null, memory?.id ?? null],
      );
      const body: ApiSuccess<{ memory: AthenaMemory | null }> = { success: true, data: { memory } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});
