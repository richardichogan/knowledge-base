import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDocumentTitle, formatTitleDate, sectionTitle } from '../src/navigation/documentTitle';

test('tab titles lead with the open item, then view and section', () => {
  assert.equal(buildDocumentTitle(['Meeting with Dhalia', 'Notes', 'Think']), 'Meeting with Dhalia · Notes · Think · Athena');
  assert.equal(buildDocumentTitle([undefined, null, '  ', 'Discover']), 'Discover · Athena');
  assert.equal(buildDocumentTitle([]), 'Athena');
});

test('repeated parts are dropped so page-level contexts do not echo the section', () => {
  assert.equal(buildDocumentTitle(['Plan', 'Board', 'Plan']), 'Plan · Board · Athena');
  assert.equal(buildDocumentTitle(['today', null, 'Today', 'Mon 19 Oct']), 'today · Mon 19 Oct · Athena');
});

test('long item names are truncated', () => {
  const title = buildDocumentTitle(['x'.repeat(100), 'Think']);
  assert.ok(title.startsWith(`${'x'.repeat(59)}… · Think`));
});

test('sections resolve from routes, including tools and standalone windows', () => {
  assert.equal(sectionTitle('/', ''), 'Today');
  assert.equal(sectionTitle('/think', '?view=sparks'), 'Think');
  assert.equal(sectionTitle('/think/notes/abc/popout', ''), 'Think');
  assert.equal(sectionTitle('/my-work', '?sync=1'), 'Connections and sync');
  assert.equal(sectionTitle('/health', ''), 'Knowledge health');
  assert.equal(sectionTitle('/chat', ''), 'Chat');
  assert.equal(sectionTitle('/nowhere', ''), undefined);
});

test('dates are short and readable', () => {
  assert.equal(formatTitleDate(new Date(2026, 9, 19)), 'Mon 19 Oct');
});
