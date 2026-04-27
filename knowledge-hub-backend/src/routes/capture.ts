import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createTodoTask } from '../integrations/graph/todoSync.js';
import { uploadBlobAsText } from '../integrations/cms/blobClient.js';
import { upsertContentItem } from '../db/queries.js';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import type { ContentItem } from '../types/contentItem.js';

const router = Router();

/**
 * POST /api/capture/task
 * Frictionless task capture from Raycast extension or web form.
 * Accepts natural language — structured parsing is handled by the Raycast
 * extension before calling this endpoint.
 * Body: { title, body?, dueDateTime?, listName?, importance? }
 */
router.post('/task', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { title, body, dueDateTime, listName, importance } = req.body as {
        title?: string;
        body?: string;
        dueDateTime?: string;
        listName?: string;
        importance?: 'low' | 'normal' | 'high';
      };

      if (!title?.trim()) {
        throw new ValidationError('title is required', { title: 'required' });
      }

      const taskId = await createTodoTask({
        title,
        ...(body !== undefined && { body }),
        ...(dueDateTime !== undefined && { dueDateTime }),
        ...(listName !== undefined && { listName }),
        ...(importance !== undefined && { importance }),
      });

      const responseBody: ApiSuccess<{ taskId: string }> = {
        success: true,
        data: { taskId },
      };
      res.status(HTTP_STATUS.CREATED).json(responseBody);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/capture/session
 * Saves a Claude Projects session export to blob storage as markdown.
 * Used by the Raycast extension as the interim export workflow.
 * Body: { filename: string (YYYY-MM-DD-topic-slug.md), content: string }
 */
router.post('/session', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { filename, content } = req.body as {
        filename?: string;
        content?: string;
      };

      if (!filename?.trim()) {
        throw new ValidationError('filename is required', { filename: 'required' });
      }
      if (!content?.trim()) {
        throw new ValidationError('content is required', { content: 'required' });
      }
      if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(filename)) {
        throw new ValidationError(
          'filename must match YYYY-MM-DD-topic-slug.md',
          { filename: 'Invalid format' },
        );
      }

      await uploadBlobAsText(
        env.CMS_BLOB_CONTAINER,
        `sessions/${filename}`,
        content,
        'text/markdown',
      );

      const body: ApiSuccess<{ blobPath: string }> = {
        success: true,
        data: { blobPath: `sessions/${filename}` },
      };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/capture/ibm-calendar
 * Change 004 — Manual IBM work calendar import.
 *
 * IBM conditional access policies block automated Graph API access from
 * non-IBM devices. This endpoint accepts a JSON array of calendar events
 * (generated via the Outlook Copilot prompt in IBM_CALENDAR_INTEGRATION.md)
 * and upserts them into the content_items table as 'ibm-graph-calendar' source items.
 *
 * Body: { events: Array<{ id, subject, start, end, isAllDay?, location?, organiser? }> }
 */
router.post('/ibm-calendar', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const { events } = req.body as {
        events?: Array<{
          id: string;
          subject: string;
          start: string;
          end: string;
          isAllDay?: boolean;
          location?: string;
          organiser?: string;
        }>;
      };

      if (!Array.isArray(events) || events.length === 0) {
        throw new ValidationError('events array is required and must not be empty', {
          events: 'required non-empty array',
        });
      }

      let imported = 0;
      for (const event of events) {
        if (!event.id || !event.subject || !event.start) continue;

        const item: ContentItem = {
          id: '',  // assigned by DB
          source: 'graph-calendar',
          sourceId: `ibm-${event.id}`,
          title: event.subject,
          summary: [
            event.isAllDay === true ? 'All day' : `${event.start} – ${event.end}`,
            event.location !== undefined ? `📍 ${event.location}` : '',
            event.organiser !== undefined ? `👤 ${event.organiser}` : '',
          ].filter(Boolean).join('  '),
          body: '',
          publishedAt: event.start,
          indexedAt: new Date().toISOString(),
          projectContext: 'ibm-thought-leadership',
          metadata: {
            isAllDay: event.isAllDay ?? false,
            ...(event.location !== undefined && { location: event.location }),
            ...(event.organiser !== undefined && { organiser: event.organiser }),
            importedManually: true,
          },
          tags: [],
        };

        await upsertContentItem(db, item);
        imported++;
      }

      const body: ApiSuccess<{ imported: number }> = {
        success: true,
        data: { imported },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

export { router as captureRouter };
