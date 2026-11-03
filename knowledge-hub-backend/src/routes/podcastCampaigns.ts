import { Router, type Request, type RequestHandler } from 'express';
import { recordAiDecision } from '../ai/aiLedger.js';
import type { Pool } from 'pg';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { object } from '../jobs/contracts.js';
import { uuid } from '../publishing/contracts.js';
import { decidePodcastCampaign, getPodcastCampaign, preparePodcastCampaign, savePodcastLinks, replacePodcastYoutubeLink, saveRecordingTeaserCopy, savePodcastImageSpec, retryPodcastCreationReview } from '../publishing/podcastCampaignStore.js';
import { loadPodcastArtworkSource } from '../publishing/podcastCampaignAssets.js';
import { NotFoundError } from '../types/errors.js';

export function createPodcastCampaignRouter(getDb: () => Pool): Router {
  const router = Router();
  const route = (action: (req: Request) => Promise<unknown>): RequestHandler => (req, res, next) => {
    void Promise.resolve().then(() => action(req)).then(data => res.json({ success: true, data })).catch(next);
  };
  const actor = (req: Request): string => (req as AuthenticatedRequest).userId;
  router.get('/:id', route(req => getPodcastCampaign(getDb(), uuid(req.params.id))));
  router.get('/:id/posts/:postId/image/source', (req, res, next) => {
    void Promise.resolve().then(async () => {
      const campaign = await getPodcastCampaign(getDb(), uuid(req.params.id));
      const post = campaign.plan?.posts.find(post => post.id === uuid(req.params.postId));
      if (!post?.asset) throw new NotFoundError('Podcast artwork');
      const source = await loadPodcastArtworkSource(post.asset);
      res.type('image/svg+xml').attachment(`podcast-${post.id}.svg`).send(source);
    }).catch(next);
  });
  router.put('/:id/posts/:postId', route(req => {
    const body = object(req.body);
    const saved = saveRecordingTeaserCopy(getDb(), uuid(req.params.id), body.revision, uuid(req.params.postId), body.copy, actor(req));
    void saved.then(() => recordAiDecision(getDb(), { kind: 'edit', agent: 'podcast-copy-fitting', targetType: 'podcast-post', targetId: uuid(req.params.postId),
      finalContent: typeof body.copy === 'string' ? body.copy : JSON.stringify(body.copy), details: { campaignId: uuid(req.params.id) } }), () => undefined);
    return saved;
  }));
  router.put('/:id/posts/:postId/image', route(req => {
    const body = object(req.body);
    return savePodcastImageSpec(getDb(), uuid(req.params.id), body.revision, uuid(req.params.postId), body.spec, actor(req));
  }));
  router.put('/:id/links', route(req => {
    const body = object(req.body);
    return savePodcastLinks(getDb(), uuid(req.params.id), body.revision, body.links, actor(req));
  }));
  router.put('/:id/links/youtube', route(req => {
    const body = object(req.body);
    return replacePodcastYoutubeLink(getDb(), uuid(req.params.id), body.revision, body.previous, body.replacement, actor(req));
  }));
  router.post('/:id/prepare', route(req => {
    const body = object(req.body);
    return preparePodcastCampaign(getDb(), uuid(req.params.id), body.revision, actor(req), body.window);
  }));
  router.post('/:id/decision', route(req => {
    const body = object(req.body);
    const decided = decidePodcastCampaign(getDb(), uuid(req.params.id), body.revision, body.action, actor(req));
    void decided.then(() => recordAiDecision(getDb(), { kind: String(body.action), agent: 'podcast-copy-fitting', targetType: 'podcast-campaign',
      targetId: uuid(req.params.id) }), () => undefined);
    return decided;
  }));
  router.post('/:id/review', route(req => {
    const body = object(req.body);
    return retryPodcastCreationReview(getDb(), uuid(req.params.id), body.revision);
  }));
  return router;
}
