import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { KnowledgeHubError, ValidationError } from '../types/errors.js';
import { assetDesigns, attachAsset, detachAsset, getDesign, listDesigns, requiredText, searchAssets, selectDesignAsset, setSpecificationType } from '../designs/designStore.js';
import { applyFeedback, collaboration, discardFeedback, editFeedback, generateArtifact, proposeFeedback, queueFeedback, resolveProposal } from '../designs/designArtifacts.js';
import { createPackage, getPackage, packageArchive, preparePublication, publishPackage } from '../designs/designPackages.js';
import { scheduleNoteIndexing } from './notes.js';
import { writeDesignSpec } from '../designs/designSpec.js';
import { scheduleGitHubPublish } from '../services/noteGitHubService.js';
import type { Note } from '../types/index.js';

export const designsRouter = Router();
const MAX_ID_LENGTH = 100;
const MAX_SEARCH_LENGTH = 200;
const HEARTBEAT_MS = 10_000;
const wrap = (run: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction): void => {
  void run(req).then(data => { res.json({ success: true, data }); }).catch(next);
};
const body = (req: Request): Record<string, unknown> => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ValidationError('Expected a request object.');
  return req.body as Record<string, unknown>;
};
const id = (req: Request): string => requiredText(req.params['id'], 'Design ID', MAX_ID_LENGTH);
designsRouter.get('/', wrap(() => listDesigns(getDb())));
designsRouter.get('/assets/search', wrap(req => {
  const type = req.query['sourceType'];
  if (type !== undefined && type !== 'note' && type !== 'canvas') throw new ValidationError('Choose notes or diagram canvases.');
  return searchAssets(getDb(), requiredText(req.query['q'] ?? '', 'Search', MAX_SEARCH_LENGTH, true), type);
}));
designsRouter.get('/membership', wrap(req => {
  const type = req.query['type'];
  if (type !== 'note' && type !== 'canvas') throw new ValidationError('Choose a note or canvas.');
  return assetDesigns(getDb(), type, requiredText(req.query['sourceId'], 'Source ID', MAX_ID_LENGTH));
}));
designsRouter.get('/:id', wrap(req => getDesign(getDb(), id(req))));
designsRouter.post('/:id/assets', wrap(req => attachAsset(getDb(), id(req), body(req))));
designsRouter.delete('/:id/assets', wrap(req => detachAsset(getDb(), id(req), body(req))));
designsRouter.post('/:id/selection', wrap(req => selectDesignAsset(getDb(), id(req), body(req))));
designsRouter.post('/:id/specification-type', wrap(req => setSpecificationType(getDb(), id(req), body(req))));
designsRouter.get('/:id/collaboration', wrap(req => collaboration(getDb(), id(req))));
// One Blueprint run per design and instruction: other tabs that ask while it runs join it instead of paying for a duplicate.
type ArtifactRun = { result: ReturnType<typeof generateArtifact>; progress: string[]; listeners: Set<(message: string) => void> };
const artifactRuns = new Map<string, ArtifactRun>();
function sharedArtifactRun(designId: string, instruction: unknown, onProgress?: (message: string) => void): ReturnType<typeof generateArtifact> {
  const key = `${designId}\u0000${typeof instruction === 'string' ? instruction.trim() : ''}`;
  let run = artifactRuns.get(key);
  if (!run) {
    const created: ArtifactRun = { progress: [], listeners: new Set(), result: undefined as unknown as ArtifactRun['result'] };
    created.result = generateArtifact(getDb(), designId, instruction, message => {
      created.progress.push(message);
      for (const listener of created.listeners) listener(message);
    }).finally(() => { artifactRuns.delete(key); });
    artifactRuns.set(key, created);
    run = created;
  } else onProgress?.('Joining the Blueprint update already in progress');
  if (onProgress) { for (const message of run.progress) onProgress(message); run.listeners.add(onProgress); }
  const listener = onProgress;
  return run.result.finally(() => { if (listener) run.listeners.delete(listener); });
}
designsRouter.post('/:id/artifacts', (req, res, next) => {
  if (!req.headers.accept?.includes('text/event-stream')) {
    wrap(request => sharedArtifactRun(id(request), body(request)['instruction']))(req, res, next);
    return;
  }
  const designId = id(req);
  const instruction = body(req)['instruction'];
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event: object): void => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
  res.on('close', () => { clearInterval(heartbeat); });
  void sharedArtifactRun(designId, instruction, message => { send({ type: 'progress', message }); })
    .then(data => { send({ type: 'done', data }); })
    .catch((error: unknown) => {
      console.error('[Design] Visual generation failed:', error);
      send({ type: 'error', message: error instanceof KnowledgeHubError ? error.message : 'Visual generation failed. Your original documents are unchanged; retry.' });
    }).finally(() => { clearInterval(heartbeat); res.end(); });
});
designsRouter.post('/:id/feedback', wrap(req => queueFeedback(getDb(), id(req), body(req))));
designsRouter.patch('/:id/feedback/:feedbackId', wrap(req => editFeedback(getDb(), id(req), requiredText(req.params['feedbackId'], 'Feedback ID', MAX_ID_LENGTH), body(req))));
designsRouter.delete('/:id/feedback/:feedbackId', wrap(req => discardFeedback(getDb(), id(req), requiredText(req.params['feedbackId'], 'Feedback ID', MAX_ID_LENGTH))));
designsRouter.post('/:id/proposals', wrap(req => proposeFeedback(getDb(), id(req))));
const reindex = async (noteIds: string[]): Promise<void> => {
  for (const noteId of noteIds) {
    const row = (await getDb().query<{ id: string; content: string; created_at: Date; updated_at: Date; revision: number; tags: string[]; linked_items: string[]; status: Note['status']; project_id: string | null }>('SELECT * FROM notes WHERE id=$1', [noteId])).rows[0]!;
    scheduleNoteIndexing(getDb(), { id: row.id, content: row.content, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), revision: row.revision, tags: row.tags, linkedItems: row.linked_items, status: row.status, ...(row.project_id ? { projectId: row.project_id } : {}) });
  }
};
designsRouter.post('/:id/apply', wrap(async req => {
  const result = await applyFeedback(getDb(), id(req));
  await reindex(result.noteIds);
  return result;
}));
designsRouter.post('/:id/spec', wrap(async req => {
  const result = await writeDesignSpec(getDb(), id(req), body(req)['replace'] === true);
  for (const note of result.notes) scheduleNoteIndexing(getDb(), note);
  for (const noteId of result.publish) scheduleGitHubPublish(getDb(), noteId);
  return { noteId: result.noteId, title: result.title, created: result.created };
}));
designsRouter.post('/:id/proposals/:proposalId/resolve', wrap(async req => {
  const input = body(req);
  if (typeof input['accept'] !== 'boolean') throw new ValidationError('Choose Accept or Discard.');
  const result = await resolveProposal(getDb(), id(req), requiredText(req.params['proposalId'], 'Proposal ID', MAX_ID_LENGTH), input['accept']);
  await reindex(result.noteIds);
  return result;
}));
designsRouter.post('/:id/packages', wrap(req => createPackage(getDb(), id(req), body(req))));
designsRouter.get('/:id/packages/:packageId/download', (req, res, next) => {
  void getPackage(getDb(), id(req), requiredText(req.params['packageId'], 'Package ID', MAX_ID_LENGTH)).then(packageArchive).then(buffer => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="design-package.zip"');
    res.send(buffer);
  }).catch(next);
});
designsRouter.post('/:id/packages/:packageId/prepare', wrap(req => preparePublication(getDb(), id(req), requiredText(req.params['packageId'], 'Package ID', MAX_ID_LENGTH), body(req))));
designsRouter.post('/:id/packages/:packageId/publish', wrap(req => publishPackage(getDb(), id(req), requiredText(req.params['packageId'], 'Package ID', MAX_ID_LENGTH),
  requiredText(body(req)['publicationId'], 'Publication ID', MAX_ID_LENGTH), body(req)['confirmed'])));
