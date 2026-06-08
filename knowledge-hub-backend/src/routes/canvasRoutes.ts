/**
 * routes/canvasRoutes.ts
 * REST endpoints for the custom canvas.
 *
 * GET    /api/canvases                          list canvases
 * POST   /api/canvases                          create canvas
 * GET    /api/canvases/:id                      full canvas (nodes + edges)
 * PATCH  /api/canvases/:id                      update title / description / project / viewport
 * DELETE /api/canvases/:id                      delete canvas (cascades)
 *
 * POST   /api/canvases/:id/nodes                add node
 * PATCH  /api/canvases/:id/nodes/:nodeId        update node
 * DELETE /api/canvases/:id/nodes/:nodeId        delete node
 *
 * POST   /api/canvases/:id/edges                add edge
 * DELETE /api/canvases/:id/edges/:edgeId        delete edge
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { HTTP_STATUS } from '../config/constants.js';
import {
  createCanvas, listCanvases, getCanvas, updateCanvas, deleteCanvas,
  createNode, updateNode, deleteNodeById,
  createEdge, deleteEdge,
  type CreateNodeInput, type UpdateNodeInput, type EdgeType,
} from '../services/canvasService.js';

export const canvasRouter = Router();

// ── Canvas ────────────────────────────────────────────────────────────────────

canvasRouter.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try { res.json({ success: true, data: await listCanvases() }); }
    catch (err) { next(err); }
  })();
});

canvasRouter.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { title, description, project } = req.body as Record<string, string | undefined>;
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: await createCanvas(title, description, project) });
    } catch (err) { next(err); }
  })();
});

canvasRouter.get('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const canvas = await getCanvas(req.params['id'] as string);
      if (!canvas) { res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Canvas not found' }); return; }
      res.json({ success: true, data: canvas });
    } catch (err) { next(err); }
  })();
});

canvasRouter.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const patch = req.body as { title?: string; description?: string; project?: string; viewport?: object };
      const updated = await updateCanvas(req.params['id'] as string, patch);
      if (!updated) { res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Canvas not found' }); return; }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  })();
});

canvasRouter.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try { await deleteCanvas(req.params['id'] as string); res.status(HTTP_STATUS.NO_CONTENT).send(); }
    catch (err) { next(err); }
  })();
});

// ── Nodes ─────────────────────────────────────────────────────────────────────

canvasRouter.post('/:id/nodes', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const input = req.body as CreateNodeInput;
      if (!input.nodeType || input.x === undefined || input.y === undefined) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'nodeType, x, y required' }); return;
      }
      const node = await createNode(req.params['id'] as string, input);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: node });
    } catch (err) { next(err); }
  })();
});

canvasRouter.patch('/:id/nodes/:nodeId', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const patch = req.body as UpdateNodeInput;
      const node = await updateNode(req.params['id'] as string, req.params['nodeId'] as string, patch);
      if (!node) { res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Node not found' }); return; }
      res.json({ success: true, data: node });
    } catch (err) { next(err); }
  })();
});

canvasRouter.delete('/:id/nodes/:nodeId', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      await deleteNodeById(req.params['id'] as string, req.params['nodeId'] as string);
      res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (err) { next(err); }
  })();
});

// ── Edges ─────────────────────────────────────────────────────────────────────

canvasRouter.post('/:id/edges', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { sourceId, targetId, edgeType, label } = req.body as {
        sourceId?: string; targetId?: string; edgeType?: EdgeType; label?: string;
      };
      if (!sourceId || !targetId) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'sourceId, targetId required' }); return;
      }
      const edge = await createEdge(req.params['id'] as string, sourceId, targetId, edgeType, label);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: edge });
    } catch (err) { next(err); }
  })();
});

canvasRouter.delete('/:id/edges/:edgeId', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      await deleteEdge(req.params['id'] as string, req.params['edgeId'] as string);
      res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (err) { next(err); }
  })();
});
