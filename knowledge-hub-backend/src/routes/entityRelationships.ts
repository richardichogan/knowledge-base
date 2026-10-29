import { Router } from 'express';
import { addRelationship, listRelationships, relationshipScope, removeRelationship } from '../services/entityRelationships.js';
import { ValidationError } from '../types/errors.js';

export const entityRelationshipsRouter = Router();
const MAX_RELATIONSHIP_KEY_LENGTH = 700;

entityRelationshipsRouter.get('/:type/:id', (req, res, next) => {
  void (async (): Promise<void> => {
    const scope = relationshipScope(req.params['type'], req.params['id'], req.query['elementId']);
    res.json({ success: true, data: await listRelationships(scope) });
  })().catch(next);
});

entityRelationshipsRouter.post('/:type/:id', (req, res, next) => {
  void (async (): Promise<void> => {
    const input = req.body as { type?: unknown; id?: unknown; elementId?: unknown } | undefined;
    const scope = relationshipScope(req.params['type'], req.params['id'], req.query['elementId']);
    await addRelationship(scope, relationshipScope(input?.type, input?.id, input?.elementId));
    res.json({ success: true, data: await listRelationships(scope) });
  })().catch(next);
});

entityRelationshipsRouter.delete('/:type/:id', (req, res, next) => {
  void (async (): Promise<void> => {
    const scope = relationshipScope(req.params['type'], req.params['id'], req.query['elementId']);
    const key = req.query['key'];
    if (typeof key !== 'string' || !key || key.length > MAX_RELATIONSHIP_KEY_LENGTH) throw new ValidationError('Invalid link key');
    await removeRelationship(scope, key);
    res.json({ success: true, data: await listRelationships(scope) });
  })().catch(next);
});
