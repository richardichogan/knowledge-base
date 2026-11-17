import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readArtifactMessage } from '../src/features/designs/DesignVisual';
import { DocumentViewToggle } from '../src/components/DocumentView';
import { CONTENT_TYPE_OPTIONS } from '../src/notes/constants';
import type { DesignArtifact, DesignDetail, ImagineHarnessView } from '../src/types/designs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImagineHarness } from '../src/features/designs/ImagineHarness';

const artifact: DesignArtifact = { id: 'artifact', revision: 3, sources: [], html: '<p>Fixture</p>',
  blueprint: { title: 'Fixture', explanation: '', openDecisions: [], elements: [{ id: 'review', title: 'Review', content: 'Approve the evidence',
    sourceIds: ['note'], choices: ['Manual review'], components: [] }] } };
const message = { channel: 'athena-design', token: 'session-token', artifactId: 'artifact', revision: 3, elementId: 'review', selection: 'evidence', choice: null };
test('Imagine harness keeps unflagged Designs unchanged and gates workforce controls on actual approval', () => {
  const design: DesignDetail = { id: 'design', parentNoteId: 'parent', title: 'Claims', summary: '', projectId: null,
    sourceUseCaseId: null, sourceNoteId: null, status: 'draft', revision: 1, mapped: false, updatedAt: '',
    specificationType: 'imagine', imagineDemo: false, assets: [], selections: {} };
  const client = new QueryClient();
  const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><ImagineHarness design={design}
    busy={false} prepare={async () => {}} onChanged={() => {}} onBusyChange={() => {}} /></QueryClientProvider>);
  assert.doesNotMatch(render(), /Generate workforce|Approve this spec/);
  design.imagineDemo = true;
  const view: ImagineHarnessView = { enabled: true, specId: 'spec', specRevision: 1, specApproved: false, canApprove: false,
    assessmentId: null, validationFingerprint: null, approvedAt: null, blockers: ['Readiness is stale.'], blockerCount: 1, workforce: null };
  client.setQueryData(['imagine-harness', design.id], view);
  assert.match(render(), /<button[^>]*disabled=""[^>]*>Generate workforce/);
  assert.match(render(), /Readiness is stale/);
  client.setQueryData(['imagine-harness', design.id], { ...view, specApproved: true, blockers: [] });
  const approved = render();
  assert.match(approved, /<button type="button" class="kh-btn-accent">Generate workforce/);
  assert.doesNotMatch(approved, /Approve this spec/);
  client.clear();
});
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
