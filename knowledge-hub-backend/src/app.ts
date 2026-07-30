import express from 'express';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authenticate } from './middleware/auth.js';
import { timelineRouter } from './routes/timeline.js';
import { searchRouter } from './routes/search.js';
import { sourcesRouter } from './routes/sources.js';
import { aiRouter } from './routes/ai.js';
import { tasksRouter } from './routes/tasks.js';
import { captureRouter } from './routes/capture.js';
import { notesRouter } from './routes/notes.js';
import { imagesRouter } from './routes/images.js';
import { graphAuthRouter } from './routes/graphAuth.js';
import { projectsRouter } from './routes/projects.js';
import { tagsRouter } from './routes/tags.js';
import { documentsRouter } from './routes/documents.js';
import { discoverRouter } from './routes/discover.js';
import { taxonomyRouter } from './routes/taxonomy.js';
import { noteTagsRouter } from './routes/noteTags.js';
import { repoMappingsRouter } from './routes/repoMappings.js';
import { cfpRouter } from './routes/cfp.js';
import { tagSuggestionRouter } from './routes/tagSuggestionRoutes.js';
import { sparkRouter, sparkClusterRouter } from './routes/sparkRoutes.js';
import { connectionRouter } from './routes/connectionRoutes.js';
import certScoresRouter from './routes/certScores.js';
import { graphRouter } from './routes/graphRoutes.js';
import { canvasRouter } from './routes/canvasRoutes.js';
import { voiceRouter } from './routes/voiceRoutes.js';
import { todayRouter } from './routes/today.js';
import { repoProjectMappingsRouter } from './routes/repoProjectMappings.js';

/**
 * Creates and configures the Express application.
 * Middleware order matters — security headers first, then auth, then routes.
 */
export function createApp(): express.Application {
  const app = express();

  // ── Security headers ─────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS — tighten in production ─────────────────────────────────────────
  app.use(cors({ origin: process.env['CORS_ORIGIN'] ?? '*' }));

  // ── Body parsing ──────────────────────────────────────────────────────────
  // Raw binary for image uploads — MUST come before express.json so binary bodies aren't parsed as JSON
  app.use('/api/images', express.raw({ type: '*/*', limit: '20mb' }));
  // Voice audio travels as base64 JSON (see voiceRoutes.ts) — a ~30s WAV clip
  // base64-encodes to several MB, well past the default 1mb JSON limit.
  app.use('/api/voice', express.json({ limit: '20mb' }));
  app.use(express.json({ limit: '1mb' }));

  // ── Rate limiting ─────────────────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: 60 * 1_000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // ── Request logging ───────────────────────────────────────────────────────
  app.use(requestLogger);

  // ── Health check — unauthenticated ────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── OAuth routes — unauthenticated (must be before /api middleware) ──────
  app.use('/auth/graph', graphAuthRouter);

  // ── API routes — all authenticated ────────────────────────────────────────
  app.use('/api', authenticate);
  app.use('/api/timeline', timelineRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/sources', sourcesRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/voice', voiceRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/capture', captureRouter);
  app.use('/api/notes/:noteId/tags', noteTagsRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/images', imagesRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/tags', tagsRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/discover', discoverRouter);
  app.use('/api/taxonomy', taxonomyRouter);
  app.use('/api/repo-mappings', repoMappingsRouter);
  app.use('/api/cfps', cfpRouter);
  app.use('/api/tag-suggestions', tagSuggestionRouter);
  app.use('/api/sparks', sparkRouter);
  app.use('/api/spark-clusters', sparkClusterRouter);
  app.use('/api/connections', connectionRouter);
  app.use('/api/cert-scores', certScoresRouter);
  app.use('/api/graph', graphRouter);
  app.use('/api/canvases', canvasRouter);
  app.use('/api/today', todayRouter);
  app.use('/api/repo-project-mappings', repoProjectMappingsRouter);

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // ── Global error handler — must be last ───────────────────────────────────
  app.use(errorHandler);

  return app;
}
