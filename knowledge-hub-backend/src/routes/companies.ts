import { Router } from 'express';
import { getDb } from '../db/db.js';
import { ValidationError } from '../types/errors.js';
import { companyPeople, getCompany, listCompanies, saveCompany } from '../services/companies.js';
import { HTTP_STATUS } from '../config/constants.js';

export const companiesRouter = Router();
const MAX_SEARCH = 200;
companiesRouter.get('/', (req, res, next) => {
  void (async (): Promise<void> => {
    const q = req.query['q'] ?? '';
    if (typeof q !== 'string' || q.length > MAX_SEARCH) throw new ValidationError('Search must be text of at most 200 characters');
    res.json({ success: true, data: await listCompanies(getDb(), q.trim()) });
  })().catch(next);
});
companiesRouter.get('/:id/people', (req, res, next) => {
  void companyPeople(getDb(), req.params['id']).then(data => { res.json({ success: true, data }); }).catch(next);
});
companiesRouter.get('/:id', (req, res, next) => {
  void getCompany(getDb(), req.params['id']).then(data => { res.json({ success: true, data }); }).catch(next);
});
companiesRouter.post('/', (req, res, next) => {
  void saveCompany(getDb(), req.body).then(data => { res.status(HTTP_STATUS.CREATED).json({ success: true, data }); }).catch(next);
});
companiesRouter.put('/:id', (req, res, next) => {
  void saveCompany(getDb(), req.body, req.params['id']).then(data => { res.json({ success: true, data }); }).catch(next);
});
