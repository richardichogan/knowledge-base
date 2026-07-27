import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { handleConversationTurn, summariseSession, rollUpConversationSummary } from '../ai/conversationService.js';
import {
  getOrCreateSessionHistory,
  getModelHistory,
  appendTurn,
  toConversationMessages,
  setSessionTitleIfMissing,
  listSessions,
  deleteSession,
  rollUpSummaryIfNeeded,
} from '../ai/chatSessionStore.js';
import { proposeWriteAction, confirmWriteAction, cancelWriteAction, getPendingProposals } from '../ai/writeActionService.js';
import { uploadBlobAsText } from '../integrations/cms/blobClient.js';
import { env } from '../config/env.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import type { WriteActionType, WriteActionPayload } from '../types/aiContext.js';

const router = Router();

/**
 * POST /api/ai/chat
 * Sends a message and gets a response. Maintains session history in Postgres
 * (ai_chat_sessions / ai_chat_messages) so conversations survive backend
 * restarts/redeploys and can be restored by the frontend after a reload.
 * The model only ever sees a rolling summary + recent messages, not the
 * full raw history, so long-running sessions stay cheap (see chatSessionStore).
 * Body: { sessionId?: string, message: string, model?: 'gpt-4o' | 'gpt-4o-mini' }
 * If sessionId is omitted, a new session is created and its ID returned.
 */
router.post('/chat', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId: providedSessionId, message, model } = req.body as {
        sessionId?: string;
        message?: string;
        model?: 'gpt-4o' | 'gpt-4o-mini';
      };

      if (!message) throw new ValidationError('message required', { message: 'required' });

      const effectiveSessionId = providedSessionId ?? randomUUID();
      const db = getDb();
      const fullHistory = await getOrCreateSessionHistory(db, effectiveSessionId);
      const isFirstMessage = fullHistory.length === 0;
      const modelHistory = await getModelHistory(db, effectiveSessionId);

      const reply = await handleConversationTurn(db, modelHistory, message, model ?? 'gpt-4o');

      await appendTurn(db, effectiveSessionId, message, reply);
      if (isFirstMessage) await setSessionTitleIfMissing(db, effectiveSessionId, message);
      // Fire-and-forget: fold older messages into the rolling summary once the
      // session grows past the trigger threshold. Never blocks the reply.
      void rollUpSummaryIfNeeded(db, effectiveSessionId, (prev, batch) =>
        rollUpConversationSummary(prev, toConversationMessages(batch)),
      ).catch(() => {
        // Summarisation is a cost/context optimisation, not correctness-critical — a failed
        // roll-up just means this session keeps replaying full recent history a bit longer.
      });

      const pending = getPendingProposals(effectiveSessionId);

      const body: ApiSuccess<{ reply: string; sessionId: string; pendingActions: typeof pending }> = {
        success: true,
        data: { reply, sessionId: effectiveSessionId, pendingActions: pending },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * GET /api/ai/sessions
 * Lists past chat sessions for the sidebar, most recently active first.
 */
router.get('/sessions', (_req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const sessions = await listSessions(db);
      const body: ApiSuccess<{ sessions: typeof sessions }> = { success: true, data: { sessions } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * DELETE /api/ai/session/:sessionId
 * Deletes a chat session and its messages.
 */
router.delete('/session/:sessionId', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId } = req.params as { sessionId: string };
      const db = getDb();
      await deleteSession(db, sessionId);
      const body: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * GET /api/ai/session/:sessionId/history
 * Returns a session's full message history — used by the frontend to
 * restore a conversation after a page reload or reopening the standalone
 * Athena PWA window, instead of always starting from a blank slate.
 */
router.get('/session/:sessionId/history', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId } = req.params as { sessionId: string };
      const db = getDb();
      const history = await getOrCreateSessionHistory(db, sessionId);
      const body: ApiSuccess<{ sessionId: string; messages: typeof history }> = {
        success: true,
        data: { sessionId, messages: history },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/ai/session/:sessionId/end
 * Ends a session, summarises it, and saves the summary to blob storage.
 */
router.post('/session/:sessionId/end', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId } = req.params as { sessionId: string };
      const db = getDb();
      const storedHistory = await getOrCreateSessionHistory(db, sessionId);

      if (storedHistory.length === 0) {
        res.status(HTTP_STATUS.OK).json({ success: true, data: { summary: null } });
        return;
      }

      const summary = await summariseSession(toConversationMessages(storedHistory));
      const date = new Date().toISOString().substring(0, 10);
      const blobPath = `sessions/${date}-${sessionId}.md`;

      await uploadBlobAsText(env.CMS_BLOB_CONTAINER, blobPath, summary, 'text/markdown');

      const body: ApiSuccess<{ summary: string; blobPath: string }> = {
        success: true,
        data: { summary, blobPath },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/ai/actions/propose
 * Proposes a write action for user confirmation.
 * Body: { sessionId, actionType, description, payload }
 */
router.post('/actions/propose', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId, actionType, description, payload } = req.body as {
        sessionId?: string;
        actionType?: WriteActionType;
        description?: string;
        payload?: WriteActionPayload;
      };

      if (!sessionId || !actionType || !description || !payload) {
        throw new ValidationError('sessionId, actionType, description, payload all required');
      }

      const proposal = proposeWriteAction(sessionId, actionType, description, payload);
      const body: ApiSuccess<typeof proposal> = { success: true, data: proposal };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/ai/actions/:proposalId/confirm
 * Executes a write action after user confirmation.
 */
router.post('/actions/:proposalId/confirm', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { proposalId } = req.params as { proposalId: string };
      await confirmWriteAction(proposalId);
      const body: ApiSuccess<{ proposalId: string }> = {
        success: true,
        data: { proposalId },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/ai/actions/:proposalId/cancel
 */
router.post('/actions/:proposalId/cancel', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { proposalId } = req.params as { proposalId: string };
      cancelWriteAction(proposalId);
      const body: ApiSuccess<{ proposalId: string }> = {
        success: true,
        data: { proposalId },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

export { router as aiRouter };
