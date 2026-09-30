/**
 * routes/canvasRoutes.ts
 * REST endpoints for mind maps (the Think "Canvas" view).
 *
 * GET    /api/canvases[?noteId=]                   list maps (optionally those linked to a note)
 * POST   /api/canvases                             create { title?, rootLabel?, noteId?, project? }
 * GET    /api/canvases/:id                         full map (ideas, cross-links, linked notes)
 * PATCH  /api/canvases/:id                         update title / description / project / viewport
 * DELETE /api/canvases/:id                         delete map
 * POST   /api/canvases/:id/ops                     apply changes { ops: MapOp[] } → full map
 * POST   /api/canvases/:id/notes                   link a note { noteId }
 * DELETE /api/canvases/:id/notes/:noteId           unlink a note
 * GET    /api/canvases/:id/suggestions[?nodeId=&label=&body=&contextLabels=]  related content for an idea
 * GET    /api/canvases/:id/nodes/:nodeId/content   the full content behind a card (Preview)
 * POST   /api/canvases/:id/nodes/:nodeId/to-note   card + its connections → new note, or { noteId } to add to a note
 * GET    /api/canvases/:id/markdown                the map as a Markdown outline
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { HTTP_STATUS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { ValidationError, NotFoundError } from '../types/errors.js';
import {
  createCanvas, listCanvases, getCanvas, updateCanvas, deleteCanvas,
  applyOps, linkNote, unlinkNote, cardSummaryBlocks, mapMarkdown, MapOpError,
  type MapOp, type CreateMapInput,
} from '../services/canvasService.js';
import { suggestionsFor } from '../services/mapSuggestions.js';
import { loadCardText } from '../services/canvasContent.js';
import { createNoteRecord, appendBlocksToNoteRecord } from './notes.js';

export const canvasRouter = Router();

const MAX_OPS_PER_REQUEST = 200;

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

async function requireMap(id: string): Promise<NonNullable<Awaited<ReturnType<typeof getCanvas>>>> {
  const map = await getCanvas(id);
  if (map === null) throw new NotFoundError('Canvas not found');
  return map;
}

canvasRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const noteId = typeof req.query['noteId'] === 'string' && req.query['noteId'] !== '' ? req.query['noteId'] : undefined;
      res.json({ success: true, data: await listCanvases(noteId) });
    } catch (err) { next(err); }
  })();
});

canvasRouter.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const b = req.body as CreateMapInput;
      const input: CreateMapInput = {
        ...(typeof b.title === 'string' && b.title.trim() !== '' && { title: b.title.trim() }),
        ...(typeof b.rootLabel === 'string' && b.rootLabel.trim() !== '' && { rootLabel: b.rootLabel.trim() }),
        ...(typeof b.noteId === 'string' && b.noteId !== '' && { noteId: b.noteId }),
        ...(typeof b.project === 'string' && b.project !== '' && { project: b.project }),
      };
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: await createCanvas(input) });
    } catch (err) { next(err); }
  })();
});

canvasRouter.get('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try { res.json({ success: true, data: await requireMap(param(req, 'id')) }); }
    catch (err) { next(err); }
  })();
});

canvasRouter.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const patch = req.body as { title?: string; description?: string; project?: string | null; viewport?: object };
      const updated = await updateCanvas(param(req, 'id'), patch);
      if (!updated) throw new NotFoundError('Canvas not found');
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  })();
});

canvasRouter.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try { await deleteCanvas(param(req, 'id')); res.status(HTTP_STATUS.NO_CONTENT).send(); }
    catch (err) { next(err); }
  })();
});

canvasRouter.post('/:id/ops', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { ops } = req.body as { ops?: MapOp[] };
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS_PER_REQUEST) {
        throw new ValidationError('ops must be a non-empty array', { ops: 'required' });
      }
      res.json({ success: true, data: await applyOps(param(req, 'id'), ops) });
    } catch (err) {
      next(err instanceof MapOpError ? new ValidationError(err.message, { ops: err.message }) : err);
    }
  })();
});

canvasRouter.post('/:id/notes', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { noteId } = req.body as { noteId?: string };
      if (typeof noteId !== 'string' || noteId === '') throw new ValidationError('noteId required', { noteId: 'required' });
      await requireMap(param(req, 'id'));
      await linkNote(param(req, 'id'), noteId);
      res.json({ success: true, data: await requireMap(param(req, 'id')) });
    } catch (err) { next(err); }
  })();
});

canvasRouter.delete('/:id/notes/:noteId', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      await unlinkNote(param(req, 'id'), param(req, 'noteId'));
      res.json({ success: true, data: await requireMap(param(req, 'id')) });
    } catch (err) { next(err); }
  })();
});

canvasRouter.get('/:id/suggestions', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const map = await requireMap(param(req, 'id'));
      const q = (k: string): string | undefined => (typeof req.query[k] === 'string' ? req.query[k] : undefined);
      const label = q('label');
      const body = q('body');
      const contextLabels = q('contextLabels');
      res.json({ success: true, data: await suggestionsFor(map, q('nodeId'), {
        ...(label !== undefined && { label }), ...(body !== undefined && { body }), ...(contextLabels !== undefined && { contextLabels }),
      }) });
    } catch (err) { next(err); }
  })();
});

canvasRouter.get('/:id/nodes/:nodeId/content', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const map = await requireMap(param(req, 'id'));
      const node = map.nodes.find((n) => n.id === param(req, 'nodeId'));
      if (node === undefined) throw new NotFoundError('Card not found');
      res.json({ success: true, data: await loadCardText(getDb(), node) });
    } catch (err) { next(err); }
  })();
});

canvasRouter.post('/:id/nodes/:nodeId/to-note', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const map = await requireMap(param(req, 'id'));
      const { noteId } = req.body as { noteId?: string };
      const db = getDb();
      if (typeof noteId === 'string' && noteId !== '') {
        const { blocks } = cardSummaryBlocks(map, param(req, 'nodeId'), true);
        await appendBlocksToNoteRecord(db, noteId, blocks);
        res.json({ success: true, data: { noteId, created: false } });
        return;
      }
      const { title, blocks } = cardSummaryBlocks(map, param(req, 'nodeId'), false);
      const note = await createNoteRecord(db, {
        content: JSON.stringify({ title, contentType: 'note', contentJson: JSON.stringify(blocks) }),
        tags: [],
        ...(map.project !== null && { projectId: map.project }),
      });
      await linkNote(map.id, note.id);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: { noteId: note.id, created: true } });
    } catch (err) {
      next(err instanceof MapOpError ? new ValidationError(err.message, {}) : err);
    }
  })();
});

canvasRouter.get('/:id/markdown', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const map = await requireMap(param(req, 'id'));
      res.json({ success: true, data: { markdown: mapMarkdown(map) } });
    } catch (err) { next(err); }
  })();
});
