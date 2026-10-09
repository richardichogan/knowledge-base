import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteFilename } from '../src/notes/noteFilename';

test('GitHub filenames use readable titles and stay within publication path rules', () => {
  assert.equal(noteFilename('IMAGINE: Executive Travel Disruption Recovery — spec'),
    'imagine-executive-travel-disruption-recovery-spec.md');
  assert.equal(noteFilename(' Café / résumé: 2026? '), 'café-résumé-2026.md');
  assert.equal(noteFilename('旅行计划'), '旅行计划.md');
  assert.equal(noteFilename('../.github\\workflows%'), 'github-workflows.md');
  assert.equal(noteFilename('   '), 'untitled-note.md');
  assert.equal(noteFilename('?!'), 'untitled-note.md');
  assert.ok(`content/notes/${noteFilename('Long title '.repeat(100))}`.length <= 240);
  assert.equal(noteFilename('Cafe\u0301'), noteFilename('Café'));
  assert.doesNotThrow(() => encodeURIComponent(noteFilename(`${'a'.repeat(179)}𐐀`)));
});
