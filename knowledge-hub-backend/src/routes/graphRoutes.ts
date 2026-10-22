import { Router } from 'express';
import { getDb } from '../db/db.js';
import { parseAtlasQuery, readGraphAtlas } from '../services/graphAtlas.js';

export const graphRouter = Router();

graphRouter.get('/', (req, res, next): void => {
  void (async (): Promise<void> => {
    try {
      const data = await readGraphAtlas(getDb(), parseAtlasQuery(req.query));
      res.json({ success: true, data });
    } catch (error) { next(error); }
  })();
});
