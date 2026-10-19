import { Router } from 'express';
import { getDb } from '../db/db.js';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { getPerson, importPeople, listPeople, savePerson } from '../services/people.js';
import { HTTP_STATUS } from '../config/constants.js';

export const peopleRouter = Router();
const MAX_SEARCH = 200;
peopleRouter.get('/', (req, res, next) => {
  void (async (): Promise<void> => {
    const q = req.query['q'] ?? '';
    if (typeof q !== 'string' || q.length > MAX_SEARCH) throw new ValidationError('Search must be text of at most 200 characters');
    res.json({ success: true, data: await listPeople(getDb(), q.trim()) });
  })().catch(next);
});
peopleRouter.post('/import', (req, res, next) => {
  const body: unknown = req.body;
  const people = body && typeof body === 'object' && 'people' in body ? body.people : undefined;
  void importPeople(getDb(), people).then(data => { res.json({ success: true, data }); }).catch(next);
});
peopleRouter.get('/:id', (req, res, next) => {
  void getPerson(getDb(), req.params['id']).then(data => { res.json({ success: true, data }); }).catch(next);
});
peopleRouter.post('/', (req, res, next) => {
  void savePerson(getDb(), req.body).then(data => { res.status(HTTP_STATUS.CREATED).json({ success: true, data }); }).catch(next);
});
peopleRouter.put('/:id', (req, res, next) => {
  void savePerson(getDb(), req.body, req.params['id']).then(data => { res.json({ success: true, data }); }).catch(next);
});
peopleRouter.delete('/:id', (req, res, next) => {
  void (async (): Promise<void> => {
    const { rowCount } = await getDb().query('DELETE FROM people WHERE id::text=$1', [req.params['id']]);
    if (!rowCount) throw new NotFoundError('Person');
    res.json({ success: true, data: { deleted: true } });
  })().catch(next);
});
