import { Router, type RequestHandler } from 'express';
import { getDb } from '../db/db.js';
import { listWatchlists, saveWatchlist, getWatchlist, watchlistHistory, watchlistBaselines, watchlistCompanyKnowledge, runWatchlist, watchlistId } from '../services/discoverWatchlists.js';
import { listInterestWeights, saveInterestWeight } from '../services/discoverInterests.js';
import { HTTP_STATUS } from '../config/constants.js';
import { positiveInteger } from '../utils/queryValidation.js';

export const discoverMonitoringRouter = Router();
const handle = (action: (req: Parameters<RequestHandler>[0]) => Promise<unknown>, created = false): RequestHandler => (req, res, next) => {
  void action(req).then(data => { res.status(created ? HTTP_STATUS.CREATED : HTTP_STATUS.OK).json({ success: true, data }); }).catch(next);
};
discoverMonitoringRouter.get('/watchlists', handle(() => listWatchlists(getDb())));
discoverMonitoringRouter.post('/watchlists', handle(req => saveWatchlist(getDb(), req.body), true));
discoverMonitoringRouter.get('/watchlists/:id', handle(req => getWatchlist(getDb(), watchlistId(req.params['id']))));
discoverMonitoringRouter.put('/watchlists/:id', handle(req => saveWatchlist(getDb(), req.body, watchlistId(req.params['id']), (req.body as Record<string, unknown> | undefined)?.['revision'])));
discoverMonitoringRouter.get('/watchlists/:id/runs', handle(req => watchlistHistory(getDb(), watchlistId(req.params['id']), {
  page: positiveInteger(req.query['page'], 'page', 1),
})));
discoverMonitoringRouter.get('/watchlists/:id/baselines', handle(req => watchlistBaselines(getDb(), watchlistId(req.params['id']))));
discoverMonitoringRouter.get('/watchlists/:id/companies', handle(req => watchlistCompanyKnowledge(getDb(), watchlistId(req.params['id']))));
discoverMonitoringRouter.post('/watchlists/:id/run', handle(req => runWatchlist(getDb(), watchlistId(req.params['id']))));
discoverMonitoringRouter.get('/interests', handle(() => listInterestWeights(getDb())));
discoverMonitoringRouter.put('/interests', handle(req => saveInterestWeight(getDb(), req.body)));
