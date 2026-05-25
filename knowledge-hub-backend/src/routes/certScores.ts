/**
 * certScores.ts — Practice exam score history
 *
 * POST /api/cert-scores          { cert_code, score, task_id?, notes? }
 * GET  /api/cert-scores?cert_code=GH-900
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';

const MAX_SCORE = 100;

type Row = Record<string, unknown>;

const router = Router();

// POST /api/cert-scores
router.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { cert_code, score, task_id, notes } = req.body as {
        cert_code: string;
        score: number;
        task_id?: string;
        notes?: string;
      };
      if (!cert_code) throw new ValidationError('cert_code is required');
      if (typeof score !== 'number' || score < 0 || score > MAX_SCORE)
        throw new ValidationError('score must be a number between 0 and 100');

      const db = getDb();
      const result = await db.query<Row>(
        `INSERT INTO cert_practice_scores (cert_code, score, task_id, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [cert_code, score, task_id ?? null, notes ?? null],
      );
      const body: ApiSuccess<Row> = { success: true, data: result.rows[0] ?? {} };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) { next(err); }
  })();
});

// GET /api/cert-scores?cert_code=
router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { cert_code } = req.query as { cert_code?: string };
      if (!cert_code) throw new ValidationError('cert_code query param is required');

      const db = getDb();
      const result = await db.query<Row>(
        `SELECT * FROM cert_practice_scores
         WHERE cert_code = $1
         ORDER BY taken_at DESC`,
        [cert_code],
      );
      const body: ApiSuccess<Row[]> = { success: true, data: result.rows };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

export default router;
