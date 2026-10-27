import { Router, type Request, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { object } from '../jobs/contracts.js';
import { uuid } from '../publishing/contracts.js';
import { decidePodcastCampaign, getPodcastCampaign, preparePodcastCampaign, savePodcastLinks } from '../publishing/podcastCampaignStore.js';

export function createPodcastCampaignRouter(getDb: () => Pool): Router {
  const router = Router();
  const route = (action: (req: Request) => Promise<unknown>): RequestHandler => (req, res, next) => {
    void Promise.resolve().then(() => action(req)).then(data => res.json({ success: true, data })).catch(next);
  };
  const actor = (req: Request): string => (req as AuthenticatedRequest).userId;
  router.get('/:id', route(req => getPodcastCampaign(getDb(), uuid(req.params.id))));
  router.put('/:id/links', route(req => {
    const body = object(req.body);
    return savePodcastLinks(getDb(), uuid(req.params.id), body.revision, body.links, actor(req));
  }));
  router.post('/:id/prepare', route(req => {
    const body = object(req.body);
    return preparePodcastCampaign(getDb(), uuid(req.params.id), body.revision, actor(req), body.window);
  }));
  router.post('/:id/decision', route(req => {
    const body = object(req.body);
    return decidePodcastCampaign(getDb(), uuid(req.params.id), body.revision, body.action, actor(req));
  }));
  return router;
}
