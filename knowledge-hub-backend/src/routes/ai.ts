import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { handleConversationTurn, type TurnHooks, summariseSession, rollUpConversationSummary, formatSessionForThink, summarizeNoteContent, generateSessionTitle } from '../ai/conversationService.js';
import { getOrCreateSessionHistory, getModelHistory, appendTurn, toConversationMessages, setSessionTitleIfMissing, listSessions, deleteSession, rollUpSummaryIfNeeded, getSessionPersona, setSessionPersona, getSessionProjectId, setSessionProjectId, getSessionIdForNote, linkSessionToNote, setGeneratedSessionTitle, renameSession, setSessionPinned, countUserTurns, searchSessionIds, setPendingTurn, getPendingTurn, setNextSteps } from '../ai/chatSessionStore.js';
import { proposeWriteAction, confirmWriteAction, cancelWriteAction, getPendingProposals } from '../ai/writeActionService.js';
import { textToBlocks } from '../ai/chatTools.js';
import { outputsChangedSince } from '../ai/chatOutputs.js';
import { emptyContextUsed, type ContextUsed } from '../ai/contextUsage.js';
import { suggestNextSteps } from '../ai/nextSteps.js';
import { deleteSessionScreenBlobs, reviewScreens } from '../ai/chatScreens.js';
import { isTrackingDecisions, updateDecisionsFromExchange } from '../ai/chatDecisions.js';
import { startTurnJob, subscribeTurnJob, cancelTurnJob, getSessionTurnJob, type TurnEvent } from '../ai/turnJobs.js';
import { memoriesCreatedSince } from '../ai/athenaMemory.js';
import type { NoteEditProposal } from '../ai/noteEdits.js';
import type { MapChangeProposal } from '../ai/mapEdits.js';
import { uploadBlobAsText } from '../integrations/cms/blobClient.js';
import { createNoteRecord } from './notes.js';
import { env } from '../config/env.js';
import { HTTP_STATUS, AI_BACKGROUND_TURN_BUDGET_MS } from '../config/constants.js';
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
/** The reply payload for one chat turn (POST /chat response data and a background turn's result). */
export interface ChatTurnResult {
  reply: string;
  sessionId: string;
  persona: string;
  sources: string[];
  pendingActions: ReturnType<typeof getPendingProposals>;
  memoriesCreated: Array<{ id: string; content: string; scopeType: string; scopeValue: string | null }>;
  noteEdits: NoteEditProposal[];
  noteEditsFor: string | null;
  mapChanges: MapChangeProposal[];
  mapChangesFor: string | null;
  /** Outputs saved or revised this turn (chips on the reply, opening the Outputs panel). */
  outputsChanged: Array<{ id: string; title: string; version: number }>;
  /** The saved reply's id (for "Ask another model"). */
  assistantMessageId: string;
  /** What the reply drew on (the "Used:" line). */
  contextUsed: ContextUsed;
  /** Suggested next steps (buttons). */
  nextSteps: string[];
}

/** Runs one chat turn from a /chat request body: saves it to the session and returns the reply payload. */
async function runChatTurn(reqBody: Record<string, unknown>, hooks: TurnHooks = {}): Promise<ChatTurnResult> {
  const { sessionId: providedSessionId, message, model, persona: requestedPersona, projectId, pageContext: requestedPageContext, noteId, screenReview } = reqBody as {
    sessionId?: string;
    message?: string;
    model?: 'gpt-4o' | 'gpt-4o-mini' | 'gpt-5.4';
    persona?: string;
    projectId?: string | null;
    pageContext?: ChatPageContext;
    noteId?: string;
    /** Look at the chat's screens together first: the journey, or the marked areas of some screens. */
    screenReview?: { mode?: 'journey' | 'focus'; screenIds?: string[] };
  };

  if (!message) throw new ValidationError('message required', { message: 'required' });

  const effectiveSessionId = providedSessionId ?? randomUUID();
  let pageContext = requestedPageContext;
  if (screenReview !== undefined && message !== undefined) {
    const mode = screenReview.mode === 'focus' ? 'focus' : 'journey';
    hooks.onActivity?.(mode === 'journey' ? 'Looking at the journey screens together' : 'Looking closely at the marked areas');
    const review = await reviewScreens(getDb(), effectiveSessionId, mode, screenReview.screenIds, message);
    if (review !== null) {
      pageContext = {
        type: 'screens',
        title: review.title,
        detail: `A close look at the screenshots themselves (by the vision model), for his question:\n\n${review.review}`,
      };
    }
  }
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

  if ('projectId' in reqBody) {
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

  // The brainstorming, blog_post and demo_designer personas use the deployed reasoning
  // model route by default.
  const effectiveModel = model ?? (persona === 'brainstorming' || persona === 'blog_post' || persona === 'demo_designer' ? 'gpt-5.4' : 'gpt-4o');

  const turnStartedAt = new Date();
  const toolsUsed = new Set<string>();
  const noteEdits: NoteEditProposal[] = [];
  const mapChanges: MapChangeProposal[] = [];
  const openNoteId = typeof noteId === 'string' && noteId.trim() !== '' ? noteId.trim() : undefined;
  const contextUsed = emptyContextUsed();
  const reply = await handleConversationTurn(
    db, modelHistory, message, effectiveModel, persona, effectiveSessionId, pageContext,
    (toolName) => { toolsUsed.add(toolName); },
    { noteId: openNoteId, noteEdits, mapChanges },
    { ...hooks, contextUsed },
  );
  // Suggested next steps, made while the reply is saved (a few seconds at most).
  hooks.onActivity?.('Finishing up');
  const nextStepsPromise = suggestNextSteps(persona, message, reply);
  const sources = [...toolsUsed];

  // Store only a compact marker for the viewed document in history — not its
  // full body — so a later turn's RAG query (which folds in recent prior user
  // messages) doesn't get re-poisoned by re-injecting a huge document as a
  // full-text search query. The model still sees the full pageContext detail
  // for THIS turn via assembleMessages; it just isn't persisted verbatim.
  const historyMessage = pageContext
    ? `[Viewing ${pageContext.type}: "${pageContext.title}"]\n${message}`
    : message;
  const { assistantMessageId } = await appendTurn(db, effectiveSessionId, historyMessage, reply, { persona, sources, contextUsed });
  if (isFirstMessage) await setSessionTitleIfMissing(db, effectiveSessionId, message);
  // Fire-and-forget AI title from the opening exchange (re-run on the
  // second turn, since first messages are often just "hello"). Never
  // overwrites a title the user set themselves.
  void (async () => {
    const turns = await countUserTurns(db, effectiveSessionId);
    if (turns > 2) return;
    const title = await generateSessionTitle(message, reply);
    await setGeneratedSessionTitle(db, effectiveSessionId, title);
  })().catch(() => {
    // Titles are cosmetic; the truncated first message stays if this fails.
  });
  // Fire-and-forget: fold older messages into the rolling summary once the
  // session grows past the trigger threshold. Never blocks the reply.
  void rollUpSummaryIfNeeded(db, effectiveSessionId, (prev, batch) =>
    rollUpConversationSummary(prev, toConversationMessages(batch)),
  ).catch(() => {
    // Summarisation is a cost/context optimisation, not correctness-critical — a failed
    // roll-up just means this session keeps replaying full recent history a bit longer.
  });

  // Keep the chat's Decisions list up to date (specialist personas, or when turned on).
  void isTrackingDecisions(db, effectiveSessionId).then((t) => (t.enabled
    ? updateDecisionsFromExchange(db, effectiveSessionId, message, reply)
    : false)).catch(() => { /* convenience only */ });
  const outputsChanged = (await outputsChangedSince(db, effectiveSessionId, turnStartedAt))
    .map((o) => ({ id: o.id, title: o.title, version: o.version }));

  const nextSteps = await nextStepsPromise;
  if (nextSteps.length > 0 && assistantMessageId !== '') {
    await setNextSteps(db, assistantMessageId, nextSteps).catch(() => { /* buttons are a convenience */ });
  }
  const pending = getPendingProposals(effectiveSessionId);
  // Instructions saved via the remember tool this turn — the UI confirms them with Undo.
  const memoriesCreated = toolsUsed.has('remember')
    ? (await memoriesCreatedSince(db, effectiveSessionId, turnStartedAt)).map((m) => ({ id: m.id, content: m.content, scopeType: m.scopeType, scopeValue: m.scopeValue }))
    : [];

  return {
      reply, sessionId: effectiveSessionId, persona, sources, pendingActions: pending, memoriesCreated, outputsChanged, assistantMessageId, contextUsed, nextSteps,
      // Proposed edits to the open note, applied client-side on "Apply".
      noteEdits, noteEditsFor: noteEdits.length > 0 ? openNoteId ?? null : null,
      // Proposed changes to the open mind map, applied on "Apply".
    mapChanges, mapChangesFor: mapChanges.length > 0 && openNoteId?.startsWith('map:') === true ? openNoteId.slice('map:'.length) : null,
  };
}

router.post('/chat', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const data = await runChatTurn(req.body);
      const body: ApiSuccess<ChatTurnResult> = { success: true, data };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/ai/chat/turns — same body as /chat, but the turn runs in the
 * background: responds at once with { turnId, sessionId }; follow it with
 * GET /chat/turns/:turnId/events. The answer is saved to the chat even if
 * the browser goes away.
 */
router.post('/chat/turns', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const reqBody = req.body as Record<string, unknown>;
      const message = reqBody['message'];
      if (typeof message !== 'string' || message.trim() === '') throw new ValidationError('message required', { message: 'required' });
      const sessionId = typeof reqBody['sessionId'] === 'string' && reqBody['sessionId'] !== '' ? reqBody['sessionId'] : randomUUID();
      const turnId = randomUUID();
      const db = getDb();
      const shown = message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message;
      await setPendingTurn(db, sessionId, { turnId, message: shown, startedAt: new Date().toISOString() });
      startTurnJob(
        turnId, sessionId, shown,
        (hooks) => runChatTurn({ ...reqBody, sessionId }, { ...hooks, budgetMs: AI_BACKGROUND_TURN_BUDGET_MS }),
        () => { void setPendingTurn(db, sessionId, null).catch((err: unknown) => { console.error('[turn] could not clear pending turn:', err); }); },
      );
      const body: ApiSuccess<{ turnId: string; sessionId: string }> = { success: true, data: { turnId, sessionId } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * GET /api/ai/chat/turns/:turnId/events — server-sent events for a turn:
 * a snapshot first (message, activity, text so far), then activity / delta /
 * reset events, ending with done (the /chat payload) or error.
 */
router.get('/chat/turns/:turnId/events', (req: Request, res: Response): void => {
  const turnId = req.params['turnId'] ?? '';
  res.writeHead(HTTP_STATUS.OK, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (e: TurnEvent | { type: 'gone' }): void => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
  let unsubscribe: (() => void) | null = null;
  unsubscribe = subscribeTurnJob(turnId, (e) => {
    send(e);
    if (e.type === 'done' || e.type === 'error') res.end();
  });
  if (unsubscribe === null) {
    // Finished long ago or lost in a restart — the client reloads the chat.
    send({ type: 'gone' });
    res.end();
    return;
  }
  const heartbeat = setInterval(() => { res.write(': keep-alive\n\n'); }, 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe?.();
  });
});

/** POST /api/ai/chat/turns/:turnId/cancel — the Stop button. */
router.post('/chat/turns/:turnId/cancel', (req: Request, res: Response): void => {
  const body: ApiSuccess<{ stopped: boolean }> = { success: true, data: { stopped: cancelTurnJob(req.params['turnId'] ?? '') } };
  res.status(HTTP_STATUS.OK).json(body);
});

/**
 * GET /api/ai/session/:sessionId/turn — a turn still running for this chat
 * (to reattach to), or one cut off by a restart ("interrupted"), or null.
 */
router.get('/session/:sessionId/turn', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      const live = getSessionTurnJob(sessionId);
      type TurnState = { status: 'running'; turnId: string; message: string; startedAt: string } | { status: 'interrupted'; message: string; startedAt: string } | null;
      let data: TurnState = null;
      if (live !== null) {
        data = { status: 'running', turnId: live.id, message: live.message, startedAt: live.startedAt };
      } else {
        const pending = await getPendingTurn(getDb(), sessionId);
        if (pending !== null) data = { status: 'interrupted', message: pending.message, startedAt: pending.startedAt };
      }
      const body: ApiSuccess<TurnState> = { success: true, data };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/** DELETE /api/ai/session/:sessionId/turn — dismisses an interrupted turn notice. */
router.delete('/session/:sessionId/turn', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      if (getSessionTurnJob(sessionId) === null) await setPendingTurn(getDb(), sessionId, null);
      const body: ApiSuccess<{ cleared: boolean }> = { success: true, data: { cleared: true } };
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
 * GET /api/ai/sessions/search?q=
 * Sidebar search across chat titles AND message text. Returns matching ids;
 * the sidebar filters its already-loaded list with them.
 */
router.get('/sessions/search', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
      const ids = await searchSessionIds(getDb(), q);
      const body: ApiSuccess<{ ids: string[] }> = { success: true, data: { ids } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * PATCH /api/ai/session/:sessionId/title
 * User rename. Body: { title: string }. Locks the title against auto-titling.
 */
router.patch('/session/:sessionId/title', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId } = req.params as { sessionId: string };
      const { title } = req.body as { title?: unknown };
      if (typeof title !== 'string' || title.trim() === '') {
        throw new ValidationError('title required', { title: 'required' });
      }
      await renameSession(getDb(), sessionId, title);
      const body: ApiSuccess<{ sessionId: string; title: string }> = { success: true, data: { sessionId, title: title.trim() } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * PATCH /api/ai/session/:sessionId/pinned
 * Pins/unpins a chat in the sidebar. Body: { pinned: boolean }
 */
router.patch('/session/:sessionId/pinned', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { sessionId } = req.params as { sessionId: string };
      const { pinned } = req.body as { pinned?: unknown };
      if (typeof pinned !== 'boolean') throw new ValidationError('pinned must be boolean', { pinned: 'boolean' });
      await setSessionPinned(getDb(), sessionId, pinned);
      const body: ApiSuccess<{ sessionId: string; pinned: boolean }> = { success: true, data: { sessionId, pinned } };
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
      // Its screenshots live in blob storage, not the database — remove them first.
      await deleteSessionScreenBlobs(db, sessionId).catch((err: unknown) => { console.error('[screens] could not delete images:', err); });
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
