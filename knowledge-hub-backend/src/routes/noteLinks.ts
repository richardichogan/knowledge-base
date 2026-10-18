import { Router } from 'express';
import { getDb } from '../db/db.js';
import { LINK_TYPES, findLinkTargets, suggestLinkTargets, entityBacklinks, unlinkedNoteMentions, linkPreview, noteBacklinks, type LinkType } from '../services/noteLinks.js';
import { ValidationError } from '../types/errors.js';
import { positiveInteger } from '../utils/queryValidation.js';

export const noteLinksRouter = Router();
const MAX_LINK_TEXT = 200;
const MAX_LINK_TYPE = 20;
const MAX_BACKLINK_PAGE = 10_000;
const BACKLINK_PAGE_SIZE = 20;
const ASCII_SPACE = 32;
const MAX_SUGGESTION_TEXT = 200_000;

noteLinksRouter.post('/link-suggestions', (req, res, next) => {
  void (async (): Promise<void> => {
    const body = req.body as { text?: unknown; exclude?: unknown } | undefined;
    if (typeof body?.text !== 'string' || body.text.length > MAX_SUGGESTION_TEXT) throw new ValidationError('Writing is too long for link suggestions.');
    if (body.exclude !== undefined && (typeof body.exclude !== 'string' || body.exclude.length > MAX_LINK_TEXT)) throw new ValidationError('Invalid excluded note');
    res.json({ success: true, data: await suggestLinkTargets(getDb(), body.text, body.exclude) });
  })().catch(next);
});

noteLinksRouter.get('/entity-backlinks', (req, res, next) => {
  void (async (): Promise<void> => {
    const type = req.query['type'];
    const id = req.query['id'];
    if (typeof type !== 'string' || !LINK_TYPES.some(t => t === type)) throw new ValidationError('Invalid link type');
    if (typeof id !== 'string' || !id || id.length > MAX_LINK_TEXT) throw new ValidationError('Invalid id');
    const page = positiveInteger(req.query['page'], 'page', 1);
    if (page > MAX_BACKLINK_PAGE) throw new ValidationError('Backlink page is too large');
    res.json({ success: true, data: await entityBacklinks(getDb(), type as LinkType, id, (page - 1) * BACKLINK_PAGE_SIZE) });
  })().catch(next);
});

noteLinksRouter.get('/link-targets', (req, res, next) => {
  void (async (): Promise<void> => {
    const text = (name: string, max: number): string | undefined => {
      const value = req.query[name];
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || value.length > max || [...value].some(char => char.charCodeAt(0) < ASCII_SPACE)) throw new ValidationError(`Invalid ${name}`);
      return value.trim();
    };
    const q = text('q', MAX_LINK_TEXT) ?? '';
    const type = text('type', MAX_LINK_TYPE);
    if (type !== undefined && !LINK_TYPES.some(t => t === type)) throw new ValidationError('Invalid link type');
    res.json({ success: true, data: await findLinkTargets(getDb(), q, type as LinkType | undefined, text('id', MAX_LINK_TEXT), text('exclude', MAX_LINK_TEXT)) });
  })().catch(next);
});

noteLinksRouter.get('/link-preview', (req, res, next) => {
  void (async (): Promise<void> => {
    const type = req.query['type'];
    const id = req.query['id'];
    if (typeof type !== 'string' || type === 'note' || !LINK_TYPES.some(t => t === type)) throw new ValidationError('Invalid link type');
    if (typeof id !== 'string' || !id || id.length > MAX_LINK_TEXT) throw new ValidationError('Invalid id');
    res.json({ success: true, data: await linkPreview(getDb(), type as Exclude<LinkType, 'note'>, id) });
  })().catch(next);
});

noteLinksRouter.get('/:id/unlinked-mentions', (req, res, next) => {
  void (async (): Promise<void> => {
    const id = req.params['id'] ?? '';
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Invalid note ID');
    const page = positiveInteger(req.query['page'], 'page', 1);
    if (page > MAX_BACKLINK_PAGE) throw new ValidationError('Mention page is too large');
    res.json({ success: true, data: await unlinkedNoteMentions(getDb(), id, (page - 1) * BACKLINK_PAGE_SIZE) });
  })().catch(next);
});

noteLinksRouter.get('/:id/backlinks', (req, res, next) => {
  void (async (): Promise<void> => {
    const id = req.params['id'] ?? '';
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Invalid note ID');
    const page = positiveInteger(req.query['page'], 'page', 1);
    if (page > MAX_BACKLINK_PAGE) throw new ValidationError('Backlink page is too large');
    res.json({ success: true, data: await noteBacklinks(getDb(), id, (page - 1) * BACKLINK_PAGE_SIZE) });
  })().catch(next);
});
