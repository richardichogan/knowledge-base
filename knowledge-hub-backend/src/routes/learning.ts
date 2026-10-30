import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db/db.js';
import { handOff, listAgentJobs } from '../agents/index.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { ValidationError } from '../types/errors.js';
import { LEARNING_LIMITS, record, text } from '../learning/contracts.js';
import { askLearningAgent } from '../learning/agent.js';
import { answerLearningQuestion, createLearningSession, getLearningSession, learningOverview, learningQuestionView,
  learningSessionDetail, learningSessionHasAllQuestions, reportLearningQuestion, skipLearningQuestion } from '../learning/store.js';
import { learningTopicHistory } from '../learning/progress.js';

export const learningRouter = Router();
const wrap = (run: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction): void => {
  void run(req).then(data => { res.json({ success: true, data }); }).catch(next);
};
const owner = (req: Request): string => (req as AuthenticatedRequest).userId;
const sessionId = (req: Request): string => {
  const id = req.params['id'];
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Invalid learning session ID.');
  return id;
};
const position = (req: Request): number => {
  const value = req.params['position'];
  if (!value || !/^[0-9]$/.test(value)) throw new ValidationError('Invalid learning question position.');
  return Number(value);
};
const modelLimit = rateLimit({ windowMs: 60_000, max: 6, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: { code: 'LEARNING_RATE_LIMIT', message: 'Please wait before requesting more learning work.' } } });

learningRouter.get('/', wrap(req => learningOverview(getDb(), owner(req))));
learningRouter.get('/topics/:topic/history', wrap(req => {
  const offset = req.query['offset'] ?? '0';
  if (typeof offset !== 'string' || !/^\d{1,7}$/.test(offset)) throw new ValidationError('Invalid learning history offset.');
  return learningTopicHistory(getDb(), owner(req), req.params['topic'] ?? '', Number(offset));
}));
learningRouter.post('/sessions', modelLimit, wrap(async req => {
  const db = getDb();
  const session = await createLearningSession(db, owner(req));
  if (session.status === 'preparing' || !await learningSessionHasAllQuestions(db, session.id)) {
    await handOff(db, { specialist: 'learning-question-writer', subjectId: session.id, requestedBy: 'app' });
    await db.query("UPDATE learning_sessions SET status='preparing',error=NULL WHERE id=$1", [session.id]);
  }
  return { id: session.id };
}));
learningRouter.get('/sessions/:id', wrap(req => learningSessionDetail(getDb(), sessionId(req), owner(req))));
learningRouter.get('/sessions/:id/jobs', wrap(async req => {
  await getLearningSession(getDb(), sessionId(req), owner(req));
  return listAgentJobs(getDb(), { subjectType: 'learning-session', subjectId: sessionId(req), limit: 5 });
}));
learningRouter.post('/sessions/:id/prepare', modelLimit, wrap(async req => {
  const db = getDb();
  const id = sessionId(req);
  const session = await getLearningSession(db, id, owner(req));
  if (session.status !== 'ready' || !await learningSessionHasAllQuestions(db, id)) {
    const job = await handOff(db, { specialist: 'learning-question-writer', subjectId: id, requestedBy: 'app' });
    await db.query("UPDATE learning_sessions SET status='preparing',error=NULL WHERE id=$1", [id]);
    return job;
  }
  throw new ValidationError('This learning session is already ready.');
}));
learningRouter.get('/sessions/:id/items/:position', wrap(req => learningQuestionView(getDb(), sessionId(req), position(req), owner(req))));
learningRouter.post('/sessions/:id/items/:position/answer', wrap(async req => {
  await answerLearningQuestion(getDb(), sessionId(req), position(req), owner(req), record(req.body)['chosen']);
  return { saved: true };
}));
learningRouter.post('/sessions/:id/items/:position/skip', wrap(async req => {
  await skipLearningQuestion(getDb(), sessionId(req), position(req), owner(req));
  return { saved: true };
}));
learningRouter.post('/sessions/:id/items/:position/report', wrap(async req => {
  const reason = text(record(req.body)['reason'], 'Report reason', LEARNING_LIMITS.promptChars);
  await reportLearningQuestion(getDb(), sessionId(req), position(req), owner(req), reason);
  return { saved: true };
}));
learningRouter.post('/sessions/:id/items/:position/discuss', modelLimit, wrap(req =>
  askLearningAgent(getDb(), sessionId(req), position(req), owner(req), record(req.body)['question'])));
