/**
 * routes/canvasRoutes.ts
 * REST endpoints for Canvas v2.
 *
 * POST   /api/canvases                      create canvas
 * GET    /api/canvases                      list canvases (no snapshot)
 * GET    /api/canvases/:id                  full canvas + edges
 * PATCH  /api/canvases/:id                  update name / snapshot
 * DELETE /api/canvases/:id                  delete canvas (cascades)
 * POST   /api/canvases/:id/edges            create edge
 * PATCH  /api/canvases/:id/edges/:edgeId    update edge label
 * DELETE /api/canvases/:id/edges/:edgeId    delete edge
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { HTTP_STATUS } from '../config/constants.js';
import {
  createCanvas,
  listCanvases,
  getCanvas,
  updateCanvas,
  deleteCanvas,
  createCanvasEdge,
  updateCanvasEdge,
  deleteCanvasEdge,
} from '../services/canvasService.js';

export const canvasRouter = Router();

// POST /api/canvases
canvasRouter.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { name } = req.body as { name?: string };
      const canvas = await createCanvas(name);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: canvas });
    } catch (err) { next(err); }
  })();
});

// GET /api/canvases
canvasRouter.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const canvases = await listCanvases();
      res.json({ success: true, data: canvases });
    } catch (err) { next(err); }
  })();
});

// GET /api/canvases/:id
canvasRouter.get('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const canvas = await getCanvas(req.params['id'] as string);
      if (!canvas) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Canvas not found' });
        return;
      }
      res.json({ success: true, data: canvas });
    } catch (err) { next(err); }
  })();
});

// PATCH /api/canvases/:id
canvasRouter.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const body = req.body as { name?: string; tldrawSnapshot?: Record<string, unknown> };
      const payload: { name?: string; tldrawSnapshot?: Record<string, unknown> } = {};
      if (body.name !== undefined) payload.name = body.name;
      if (body.tldrawSnapshot !== undefined) payload.tldrawSnapshot = body.tldrawSnapshot;
      const updated = await updateCanvas(req.params['id'] as string, payload);
      if (!updated) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Canvas not found' });
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  })();
});

// DELETE /api/canvases/:id
canvasRouter.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      await deleteCanvas(req.params['id'] as string);
      res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (err) { next(err); }
  })();
});

// POST /api/canvases/:id/edges
canvasRouter.post('/:id/edges', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { sourceNodeId, targetNodeId, label, tldrawShapeId } = req.body as {
        sourceNodeId?: string;
        targetNodeId?: string;
        label?: string;
        tldrawShapeId?: string;
      };
      if (!sourceNodeId || !targetNodeId || !label || !tldrawShapeId) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'sourceNodeId, targetNodeId, label, tldrawShapeId required' });
        return;
      }
      const edge = await createCanvasEdge(req.params['id'] as string, sourceNodeId, targetNodeId, label, tldrawShapeId);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: edge });
    } catch (err) { next(err); }
  })();
});

// PATCH /api/canvases/:id/edges/:edgeId
canvasRouter.patch('/:id/edges/:edgeId', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { label } = req.body as { label?: string };
      if (!label) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'label required' });
        return;
      }
      const edge = await updateCanvasEdge(req.params['id'] as string, req.params['edgeId'] as string, label);
      if (!edge) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Edge not found' });
        return;
      }
      res.json({ success: true, data: edge });
    } catch (err) { next(err); }
  })();
});

// DELETE /api/canvases/:id/edges/:edgeId
canvasRouter.delete('/:id/edges/:edgeId', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      await deleteCanvasEdge(req.params['id'] as string, req.params['edgeId'] as string);
      res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (err) { next(err); }
  })();
});
