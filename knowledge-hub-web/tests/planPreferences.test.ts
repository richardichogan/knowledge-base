import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PLAN_PREFERENCES, parsePlanPreferences } from '../src/utils/planPreferences';

test('Plan preferences preserve the mode and exact project/tag scopes in a versioned device-local record', () => {
  const preferences = { version: 1, view: 'focus', project: 'project-fixture', tag: 'tag-fixture' };
  assert.deepEqual(parsePlanPreferences(JSON.stringify(preferences)), preferences);
  assert.deepEqual(parsePlanPreferences(null), DEFAULT_PLAN_PREFERENCES);
});

test('Plan preferences remember the Use cases view', () => {
  const preferences = { version: 1, view: 'use-cases', project: '', tag: '' };
  assert.deepEqual(parsePlanPreferences(JSON.stringify(preferences)), preferences);
});

test('the misplaced Designs preference returns to the task board without changing project scope', () => {
  const preferences = { version: 1, view: 'designs', project: 'project-fixture', tag: '' };
  assert.deepEqual(parsePlanPreferences(JSON.stringify(preferences)), { ...preferences, view: 'board' });
});

test('Plan preferences saved with the removed Calendar view fall back to the board', () => {
  const legacy = { version: 1, view: 'calendar', project: 'project-fixture', tag: '' };
  assert.deepEqual(parsePlanPreferences(JSON.stringify(legacy)), { ...legacy, view: 'board' });
});

test('Plan preferences saved with the old List view open Focus', () => {
  const legacy = { version: 1, view: 'list', project: '', tag: 'tag-fixture' };
  assert.deepEqual(parsePlanPreferences(JSON.stringify(legacy)), { ...legacy, view: 'focus' });
});

test('Plan preferences reject malformed, obsolete and unbounded records instead of applying broken scopes', () => {
  for (const value of ['broken', 'null', '{}', JSON.stringify({ version: 2, view: 'board', project: '', tag: '' }),
    JSON.stringify({ version: 1, view: 'unknown', project: '', tag: '' }),
    JSON.stringify({ version: 1, view: 'board', project: 'a'.repeat(257), tag: '' }),
    JSON.stringify({ version: 1, view: 'board', project: '', tag: '\ninvalid' })]) {
    assert.throws(() => parsePlanPreferences(value));
  }
});
