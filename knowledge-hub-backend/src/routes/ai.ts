import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { handleConversationTurn, summariseSession, rollUpConversationSummary, formatSessionForThink, summarizeNoteContent } from '../ai/conversationService.js';
import { getOrCreateSessionHistory, getModelHistory, appendTurn, toConversationMessages, setSessionTitleIfMissing, listSessions, deleteSession, rollUpSummaryIfNeeded, getSessionPersona, setSessionPersona, getSessionProjectId, setSessionProjectId, getSessionIdForNote, linkSessionToNote } from '../ai/chatSessionStore.js';
import { proposeWriteAction, confirmWriteAction, cancelWriteAction, getPendingProposals } from '../ai/writeActionService.js';
import { textToBlocks } from '../ai/chatTools.js';
import { uploadBlobAsText } from '../integrations/cms/blobClient.js';
import { createNoteRecord } from './notes.js';
import { env } from '../config/env.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import type { ChatPageContext, WriteActionType, WriteActionPayload } from '../types/aiContext.js';

const router = Router();

/**
 * POST /api/ai/chat
 * Sends a message and gets a response. Maintains session history in Postgres
 * (ai_chat_sessions / ai_chat_messages) so conversations survive backend
 * restarts/redeploys and can be restored by the frontend after a reload.
 * The model only ever sees a rolling summary + recent messages, not the
 * full raw history, so long-running sessions stay cheap (see chatSessionStore).
 * Body: { sessionId?: string, message: string, model?: 'gpt-4o' | 'gpt-4o-mini' | 'gpt-5.4' }
 * If sessionId is omitted, a new session is created and its ID returned.
 */
router.post('/chat', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId: providedSessionId, message, model, persona: requestedPersona, projectId, pageContext, noteId } = req.body as {
        sessionId?: string;
        message?: string;
        model?: 'gpt-4o' | 'gpt-4o-mini' | 'gpt-5.4';
        persona?: string;
        projectId?: string | null;
        pageContext?: ChatPageContext;
        noteId?: string;
      };

      if (!message) throw new ValidationError('message required', { message: 'required' });

      const effectiveSessionId = providedSessionId ?? randomUUID();
      const db = getDb();
      const fullHistory = await getOrCreateSessionHistory(db, effectiveSessionId);
      const isFirstMessage = fullHistory.length === 0;
      const modelHistory = await getModelHistory(db, effectiveSessionId);

      // Remembers which Think note (if any) this chat belongs to, so the
      // embedded Athena panel can restore it when the user switches back to
      // this note later instead of always showing the globally-active chat.
      if (typeof noteId === 'string' && noteId.trim() !== '') {
        await linkSessionToNote(db, effectiveSessionId, noteId.trim());
      }

      if ('projectId' in req.body) {
        await setSessionProjectId(
          db,
          effectiveSessionId,
          typeof projectId === 'string' && projectId.trim() !== '' ? projectId.trim() : null,
        );
      }

      // Persona is per-session, set explicitly (e.g. from the persona picker on
      // a new chat) rather than inferred per-message. If the caller passes one,
      // persist it; otherwise fall back to whatever the session already has.
      if (requestedPersona) {
        await setSessionPersona(db, effectiveSessionId, requestedPersona);
      }
      const persona = requestedPersona ?? (await getSessionPersona(db, effectiveSessionId));

      // The brainstorming and blog_post personas use the deployed reasoning
      // model route by default.
      const effectiveModel = model ?? (persona === 'brainstorming' || persona === 'blog_post' ? 'gpt-5.4' : 'gpt-4o');

      const reply = await handleConversationTurn(db, modelHistory, message, effectiveModel, persona, effectiveSessionId, pageContext);

      // Store only a compact marker for the viewed document in history — not its
      // full body — so a later turn's RAG query (which folds in recent prior user
      // messages) doesn't get re-poisoned by re-injecting a huge document as a
      // full-text search query. The model still sees the full pageContext detail
      // for THIS turn via assembleMessages; it just isn't persisted verbatim.
      const historyMessage = pageContext
        ? `[Viewing ${pageContext.type}: "${pageContext.title}"]\n${message}`
        : message;
      await appendTurn(db, effectiveSessionId, historyMessage, reply);
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

      const body: ApiSuccess<{ reply: string; sessionId: string; persona: string; pendingActions: typeof pending }> = {
        success: true,
        data: { reply, sessionId: effectiveSessionId, persona, pendingActions: pending },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * PATCH /api/ai/session/:sessionId/persona
 * Explicitly switches a session's persona (e.g. "general" <-> "brainstorming").
 * Body: { persona: string }
 */
router.patch('/session/:sessionId/persona', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId } = req.params as { sessionId: string };
      const { persona } = req.body as { persona?: string };
      if (!persona) throw new ValidationError('persona required', { persona: 'required' });

      const db = getDb();
      await setSessionPersona(db, sessionId, persona);
      const body: ApiSuccess<{ sessionId: string; persona: string }> = {
        success: true,
        data: { sessionId, persona },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * PATCH /api/ai/session/:sessionId/project
 * Assigns or clears a project for a conversation.
 * Body: { projectId: string | null }
 */
router.patch('/session/:sessionId/project', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId } = req.params as { sessionId: string };
      const { projectId } = req.body as { projectId?: string | null };
      if (!('projectId' in req.body)) {
        throw new ValidationError('projectId required', { projectId: 'required; use null to clear' });
      }

      const normalizedProjectId =
        typeof projectId === 'string' && projectId.trim() !== '' ? projectId.trim() : null;
      const db = getDb();
      await setSessionProjectId(db, sessionId, normalizedProjectId);
      const body: ApiSuccess<{ sessionId: string; projectId: string | null }> = {
        success: true,
        data: { sessionId, projectId: normalizedProjectId },
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
 * GET /api/ai/sessions/note/:noteId
 * Looks up the chat session already linked to a Think note, if any — used
 * by the embedded Athena panel to restore the right conversation when the
 * user switches notes.
 */
router.get('/sessions/note/:noteId', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { noteId } = req.params as { noteId: string };
      const db = getDb();
      const sessionId = await getSessionIdForNote(db, noteId);
      const body: ApiSuccess<{ sessionId: string | null }> = { success: true, data: { sessionId } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/ai/summarize-note
 * Generates an on-demand summary of a note's content, shown as a "summary
 * card" in the Think-embedded Athena panel when a note has no chat started
 * yet. Body: { title, content }
 */
router.post('/summarize-note', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { title, content } = req.body as { title?: string; content?: string };
      if (!title) throw new ValidationError('title required', { title: 'required' });

      const summary = await summarizeNoteContent(title, content ?? '');
      const body: ApiSuccess<{ summary: string }> = { success: true, data: { summary } };
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
      const persona = await getSessionPersona(db, sessionId);
      const projectId = await getSessionProjectId(db, sessionId);
      const body: ApiSuccess<{ sessionId: string; messages: typeof history; persona: string; projectId: string | null }> = {
        success: true,
        data: { sessionId, messages: history, persona, projectId },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/ai/session/:sessionId/export-to-think
 * Formats the session's conversation into a structured note (title, summary,
 * key points/decisions, open questions, full transcript) and saves it to the
 * Think library via the same createNoteRecord path as the create_note_draft
 * tool and POST /api/notes use. Returns the created note's id/url so the
 * frontend can deep-link straight to it.
 */
router.post('/session/:sessionId/export-to-think', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId } = req.params as { sessionId: string };
      const db = getDb();
      const history = await getOrCreateSessionHistory(db, sessionId);

      if (history.length === 0) {
        throw new ValidationError('Session has no messages to export');
      }

      const persona = await getSessionPersona(db, sessionId);
      const projectId = await getSessionProjectId(db, sessionId);
      const { title, bodyMarkdown } = await formatSessionForThink(toConversationMessages(history), persona);

      const blocks = textToBlocks(bodyMarkdown);
      const wrapper = { title, contentType: 'note', contentJson: JSON.stringify(blocks) };
      const note = await createNoteRecord(db, {
        content: JSON.stringify(wrapper),
        tags: ['athena-export'],
        ...(projectId !== null && { projectId }),
      });

      const body: ApiSuccess<{ noteId: string; title: string; url: string }> = {
        success: true,
        data: {
          noteId: note.id,
          title,
          url: `${env.FRONTEND_BASE_URL}/think?noteId=${note.id}`,
        },
      };
      res.status(HTTP_STATUS.CREATED).json(body);
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
