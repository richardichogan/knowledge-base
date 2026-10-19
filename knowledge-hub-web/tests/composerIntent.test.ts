import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildComposerIntent } from '../src/chat/composerIntent';

test('reading or discussing a Think note does not infer a note-creation action', () => {
  for (const input of [
    'Read the bloody Think note.',
    'Based on the Think note, are we describing the flow accurately?',
    'Can you review the Think note we discussed earlier?',
  ]) {
    const intent = buildComposerIntent({ input, projects: [], activeProjectId: '' });
    assert.equal(intent.effectiveAction, undefined, input);
  }
});

test('explicitly capturing material as a Think note still infers note creation', () => {
  const intent = buildComposerIntent({
    input: 'Capture this conversation as a Think note.',
    projects: [],
    activeProjectId: '',
  });
  assert.equal(intent.effectiveAction, 'note');
});
