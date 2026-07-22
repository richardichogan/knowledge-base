import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { handleConversationTurn, summariseSession } from '../ai/conversationService.js';
import { proposeWriteAction, confirmWriteAction, cancelWriteAction, getPendingProposals } from '../ai/writeActionService.js';
import { uploadBlobAsText } from '../integrations/cms/blobClient.js';
import { env } from '../config/env.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import type { ConversationMessage, WriteActionType, WriteActionPayload } from '../types/aiContext.js';

const router = Router();

// In-memory session store — replace with PostgreSQL for production
const sessions = new Map<string, { history: ConversationMessage[]; startedAt: string }>();

/**
 * POST /api/ai/chat
 * Sends a message and gets a response. Maintains session history.
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
      const session = sessions.get(effectiveSessionId) ?? { history: [], startedAt: new Date().toISOString() };
      const db = getDb();

      const reply = await handleConversationTurn(db, session.history, message, model ?? 'gpt-4o');

      session.history.push({ role: 'user', content: message });
      session.history.push({ role: 'assistant', content: reply });
      sessions.set(effectiveSessionId, session);

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
 * POST /api/ai/session/:sessionId/end
 * Ends a session, summarises it, and saves the summary to blob storage.
 */
router.post('/session/:sessionId/end', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId } = req.params as { sessionId: string };
      const session = sessions.get(sessionId);

      if (!session || session.history.length === 0) {
        res.status(HTTP_STATUS.OK).json({ success: true, data: { summary: null } });
        return;
      }

      const summary = await summariseSession(session.history);
      const date = new Date().toISOString().substring(0, 10);
      const blobPath = `sessions/${date}-${sessionId}.md`;

      await uploadBlobAsText(env.CMS_BLOB_CONTAINER, blobPath, summary, 'text/markdown');
      sessions.delete(sessionId);

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
