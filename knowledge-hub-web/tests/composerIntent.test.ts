import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildComposerIntent, composeMessageText, stripActionDirective } from '../src/chat/composerIntent';
import { insertChatMention } from '../src/chat/mentions';

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

test('Spec is an explicit per-message action with bounded, grounded agent handoff requirements', () => {
    const intent = buildComposerIntent({ input: '/spec Add document mentions', projects: [], activeProjectId: '' });
    assert.equal(intent.effectiveAction, 'spec');
    assert.equal(intent.rawText, 'Add document mentions');
    const sent = composeMessageText(intent.rawText, intent.effectiveAction);
    assert.equal(stripActionDirective(sent), 'Add document mentions');
    for (const requirement of ['cite the sources', 'non-goals', 'data contracts', 'acceptance criteria', 'stop conditions', 'blockers']) {
      assert.ok(sent.includes(requirement), requirement);
    }
    assert.equal(buildComposerIntent({ input: 'Review this technical spec', projects: [], activeProjectId: '' }).effectiveAction, undefined);
    assert.equal(buildComposerIntent({ input: 'Write an agent-ready spec for this', projects: [], activeProjectId: '' }).effectiveAction, 'spec');
});

test('saved document mention carries a stable typed reference without deleting surrounding text', () => {
    const result = insertChatMention('Use @scope please', { start: 4, end: 10 }, {
      type: 'note', id: '123', title: 'Scope [draft]', href: '/think?noteId=123', detail: 'spec',
    });
    assert.equal(result.input, 'Use @[Scope draft](/think?noteId=123)  please');
    assert.equal(result.input.slice(result.cursor), ' please');
});
