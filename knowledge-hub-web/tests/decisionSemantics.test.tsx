import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { candidateKind, DecisionSemanticsView } from '../src/components/athena/DecisionSemanticsView';
import { describeApiError } from '../src/services/apiError';
import type { DecisionSemantics } from '../src/types/semanticDecision';

const base: DecisionSemantics = {
  id: 'd1', status: 'decided', acceptance: 'unknown', acceptedAt: null, reviewDate: null, supersession: { state: 'current' },
  edges: [
    { relationship: 'implements', from: { kind: 'task', id: 't1' }, to: { kind: 'decision', id: 'd1' }, origin: 'user_confirmed', effectiveAt: null },
    { relationship: 'implements', from: { kind: 'task', id: 't4' }, to: { kind: 'decision', id: 'd1' }, origin: 'inferred', effectiveAt: null },
  ],
};
const noop = (): void => undefined;
const render = (semantics: DecisionSemantics, error: string | null = null): string =>
  renderToStaticMarkup(<DecisionSemanticsView semantics={semantics} error={error} onConfirm={noop} onSetReviewDate={noop} onRecordLink={noop} />);

test('DECUI-01 acceptance stays unknown and its button disabled until the user ticks the confirmation', () => {
  const html = render(base);
  assert.match(html, /Acceptance is not recorded\. It stays unknown/);
  assert.match(html, /I confirm this decision was accepted/);
  assert.match(html, /<button type="button" class="decision-semantics__btn" disabled="">Confirm acceptance<\/button>/);
  const accepted = render({ ...base, acceptance: 'accepted', acceptedAt: '2026-10-22T09:00:00.000Z' });
  assert.match(accepted, /Accepted — you confirmed this on 2026-10-22/);
  assert.ok(!accepted.includes('Confirm acceptance'));
});

test('DECUI-02 review date and link controls render, and inferred links are labelled as unconfirmed', () => {
  const html = render({ ...base, reviewDate: '2026-12-01' });
  assert.match(html, /type="date" class="decision-semantics__input" aria-label="Review date" value="2026-12-01"/);
  assert.match(html, /Save review date<\/button>/);
  assert.match(html, /Implemented by task t1 \(you confirmed\)/);
  assert.match(html, /decision-semantics__item--inferred">Implemented by task t4 \(suggested, not confirmed\)/);
  for (const label of ['Is implemented by task', 'Supersedes decision', 'Is superseded by decision']) assert.ok(html.includes(label), label);
  assert.match(html, /Record link<\/button>/);
  assert.ok(!html.includes('Linked id'));
});

test('DECUI-04 link picker offers searched candidates, starts empty and keeps Record link disabled', () => {
  const candidates = [{ id: 't9', label: 'Ship the pilot', detail: 'in_progress · p1' }];
  const html = renderToStaticMarkup(<DecisionSemanticsView semantics={base} candidates={candidates} onConfirm={noop} onSetReviewDate={noop} onRecordLink={noop} />);
  assert.match(html, /aria-label="Search candidates" placeholder="Search tasks"/);
  assert.match(html, /<option value="" selected="">Choose…<\/option><option value="t9">Ship the pilot \(in_progress · p1\)<\/option>/);
  assert.match(html, /disabled="">Record link<\/button>/);
  assert.match(renderToStaticMarkup(<DecisionSemanticsView semantics={base} onConfirm={noop} onSetReviewDate={noop} onRecordLink={noop} />), /<option value="" selected="">No matches<\/option>/);
  assert.match(renderToStaticMarkup(<DecisionSemanticsView semantics={base} candidatesLoading onConfirm={noop} onSetReviewDate={noop} onRecordLink={noop} />), /Searching…/);
  assert.equal(candidateKind('implements'), 'task');
  assert.equal(candidateKind('supersedes'), 'decision');
  assert.equal(candidateKind('superseded_by'), 'decision');
});

test('DECUI-03 typed server errors are shown to the user and a superseded decision is stated', () => {
  assert.match(render(base, 'This supersession would create a cycle.'), /role="alert">This supersession would create a cycle\./);
  assert.match(render({ ...base, supersession: { state: 'superseded' } }), /This decision has been superseded\./);
  assert.equal(describeApiError({ isAxiosError: true, message: 'Request failed with status code 409', response: { data: { success: false, error: { code: 'EDGE_CYCLE', message: 'This supersession would create a cycle.' } } } }), 'This supersession would create a cycle.');
});
