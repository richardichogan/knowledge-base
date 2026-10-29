import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { ValidationError } from '../types/errors.js';
import { requiredText } from '../designs/designStore.js';
import { draftScript, episodeForRecording, getEpisode, saveScript, saveShowNotes, saveTranscript, startShowNotes } from '../podcasts/podcastEpisodeStore.js';

export const podcastEpisodesRouter = Router();
const MAX_ID_LENGTH = 100;
const wrap = (run: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction): void => {
  void run(req).then(data => { res.json({ success: true, data }); }).catch(next);
};
const body = (req: Request): Record<string, unknown> => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ValidationError('Expected a request object.');
  return req.body as Record<string, unknown>;
};
const id = (req: Request): string => requiredText(req.params['id'], 'Episode ID', MAX_ID_LENGTH);

podcastEpisodesRouter.get('/recording/:date', wrap(async req => {
  const date = requiredText(req.params['date'], 'Recording date', MAX_ID_LENGTH);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('Use a YYYY-MM-DD recording date.');
  return { noteId: await episodeForRecording(getDb(), date) };
}));
podcastEpisodesRouter.get('/:id', wrap(req => getEpisode(getDb(), id(req))));
podcastEpisodesRouter.put('/:id/script', wrap(req => saveScript(getDb(), id(req), body(req))));
podcastEpisodesRouter.post('/:id/script/draft', wrap(req => draftScript(getDb(), id(req), body(req))));
podcastEpisodesRouter.post('/:id/transcript', wrap(req => {
  const fields = (req.body ?? {}) as Record<string, unknown>;
  return saveTranscript(getDb(), id(req), req.file, fields['revision']);
}));
podcastEpisodesRouter.post('/:id/show-notes/session', wrap(req => startShowNotes(getDb(), id(req))));
podcastEpisodesRouter.post('/:id/show-notes', wrap(req => saveShowNotes(getDb(), id(req), body(req))));
