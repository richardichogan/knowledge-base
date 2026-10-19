import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { browserWidths } from './browser-viewports.mjs';

test('mobile browser coverage is exclusively for the dedicated chat journey', () => {
  assert.deepEqual(browserWidths('chat'), [390]);
  for (const mode of ['navigation', 'project-pickers', 'watchlist-projects', 'discover', 'sparks', 'today',
    'podcast-prep', 'auth-session', 'auth-callback', 'note-history', 'note-recovery', 'note-popout', 'note-links',
    'watchlists', 'markdown-export', 'diagram-theme', 'diagram', 'diagram-properties', 'diagram-drilldown',
    'diagram-line-jumps', 'connections', 'think-search', 'think-save', 'note-copy', 'note-github', 'imagine-brief', undefined]) {
    assert.deepEqual(browserWidths(mode), [1440], `${mode ?? 'default'} must remain desktop-only`);
  }
});

test('both browser runners use the shared viewport policy', async () => {
  for (const runner of ['run-today-browser.mjs', 'run-diagram-browser.mjs']) {
    const source = await readFile(new URL(`../knowledge-hub-web/tests/${runner}`, import.meta.url), 'utf8');
    assert.match(source, /for \(const width of browserWidths\(/);
    assert.ok(!source.includes('[1440, 390]') && !source.includes('[1440, 1024, 390]'));
  }
});

test('mobile chat checks never navigate to non-chat application pages', async () => {
  const source = await readFile(new URL('../knowledge-hub-web/tests/navigation.browser.tsx', import.meta.url), 'utf8');
  const chat = source.slice(source.indexOf('async function runChatChecks()'), source.indexOf('async function showGraphReview()'));
  const destinations = [...chat.matchAll(/await go\('([^']+)'\)/g)].map(match => match[1]);
  assert.ok(destinations.length > 0);
  assert.ok(destinations.every(path => path === '/chat' || path === '/_chat-remount'));
  assert.ok(!chat.includes('runNavigationChecks(') && !chat.includes('runDataReliabilityChecks('));
  assert.match(source, /has\('chat-only'\) \? '\/_chat-remount' : '\/'/);
});
