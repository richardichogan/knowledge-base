import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readArtifactMessage } from '../src/features/designs/DesignVisual';
import { DocumentViewToggle } from '../src/components/DocumentView';
import { CONTENT_TYPE_OPTIONS } from '../src/notes/constants';
import type { DesignArtifact } from '../src/types/designs';

const artifact: DesignArtifact = { id: 'artifact', revision: 3, sources: [], html: '<p>Fixture</p>',
  blueprint: { title: 'Fixture', explanation: '', openDecisions: [], elements: [{ id: 'review', title: 'Review', content: 'Approve the evidence',
    sourceIds: ['note'], choices: ['Manual review'], components: [] }] } };
const message = { channel: 'athena-design', token: 'session-token', artifactId: 'artifact', revision: 3, elementId: 'review', selection: 'evidence', choice: null };
test('Design is an actual existing-flow content type, and the HTML toggle describes its shared artifact', () => {
  assert.equal(CONTENT_TYPE_OPTIONS.filter(type => type.id === 'design').length, 1);
  const html = renderToStaticMarkup(<DocumentViewToggle value="html" artifact onChange={() => {}} />);
  assert.match(html, /Athena Blueprint: a sectioned visual of the whole spec/);
  assert.match(html, /aria-pressed="true"[^>]*>Blueprint/);
});
test('artifact bridge rejects invalid token, revision, target, choices and payload shapes', () => {
  assert.deepEqual(readArtifactMessage(message, artifact, 'session-token'), { type: 'annotate', selection: { artifactId: 'artifact', elementId: 'review', selection: 'evidence', choice: null } });
  for (const changed of [
    { token: 'foreign-token' }, { revision: 2 }, { artifactId: 'old' }, { elementId: 'deleted' },
    { selection: 'a'.repeat(8001) }, { choice: 'Invented option' }, { extra: 'unexpected' },
  ]) assert.equal(readArtifactMessage({ ...message, ...changed }, artifact, 'session-token'), null);
  const chosen = readArtifactMessage({ ...message, choice: 'Manual review' }, artifact, 'session-token');
  assert.equal(chosen?.type === 'annotate' ? chosen.selection.choice : null, 'Manual review');
});
