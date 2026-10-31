import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { noteId, parseSources, targetPath } from '../src/work/workContent.js';
import { WORK_CONTENT_TOOLS, WORK_WRITE_TOOLS } from '../src/ai/workContentTools.js';

test('WORK-01: exact identities, cited refs and OneDrive paths reject malformed input', () => {
  const id = '55a65361-f56e-47b5-995b-62f0dae18b0f';
  assert.equal(noteId(id), id);
  assert.throws(() => noteId('a title instead of an identity'));
  assert.deepEqual(parseSources([{ type: 'note', id }, { type: 'note', id }]), [{ type: 'note', id }]);
  assert.throws(() => parseSources([{ type: 'email', id }]));
  assert.throws(() => parseSources(Array.from({ length: 13 }, () => ({ type: 'note', id }))));
  assert.deepEqual(targetPath('OneDrive/Athena/IMAGINE/', 'Brief.docx'), {
    targetFolder: 'Athena/IMAGINE', fileName: 'Brief.docx',
  });
  for (const folder of ['Athena/../Private', 'Other/IMAGINE', 'Athena/IMAGINE\u0000']) {
    assert.throws(() => targetPath(folder, 'Brief.docx'));
  }
  for (const file of ['../Brief.docx', 'Brief.exe', 'Brief\u001f.docx']) {
    assert.throws(() => targetPath('Athena/IMAGINE', file));
  }
});

test('WORK-02: work mutations are authoritative writes; tool contract stays Athena-only', async () => {
  const service = await readFile(new URL('../src/ai/conversationService.ts', import.meta.url), 'utf8');
  assert.match(service, /const WRITE_TOOLS = new Set\(\[\.\.\.WORK_WRITE_TOOLS/);
  for (const name of WORK_WRITE_TOOLS) assert.ok(WORK_CONTENT_TOOLS.some(tool => tool.function.name === name), name);
  assert.ok(WORK_CONTENT_TOOLS.some(tool => tool.function.name === 'read_work_content'));
  for (const tool of WORK_CONTENT_TOOLS) {
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.doesNotMatch(tool.function.description, /Cowork/);
  }
});
