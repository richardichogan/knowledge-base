import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobSummary } from '../src/components/jobs/JobReview';
import type { JobDefinition } from '../src/types/jobs';

const definition: JobDefinition = {
  name: 'Microsoft updates', kind: 'weekly-microsoft', prompt: 'Use verified sources.',
  schedule: { timezone: 'Europe/London', days: [1, 2, 3, 4, 5], times: ['08:00'] },
  approval: 'required', outputs: ['think', 'blog', 'bluesky', 'linkedin'],
  deviceId: '', inputFolder: '', outputFolder: '',
};

test('job review keeps permissions and destinations visible while disclosing the full prompt on demand', () => {
  const html = renderToStaticMarkup(<JobSummary definition={definition} />);
  assert.match(html, /Weekdays at 08:00/);
  assert.match(html, /Europe\/London/);
  assert.match(html, /Think, Blog, Bluesky, LinkedIn/);
  assert.match(html, /Approval required/);
  assert.match(html, /<details[^>]*><summary>Prompt and file settings<\/summary>/);
  assert.match(html, /Use verified sources\./);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(html, /weekly-microsoft/);
});

test('source ingestion does not imply a publishing permission that is not used', () => {
  const html = renderToStaticMarkup(<JobSummary definition={{
    ...definition, name: 'Content sync', kind: 'content-sync', prompt: '',
    outputs: [], approval: 'automatic',
  }} />);
  assert.match(html, /Source ingestion/);
  assert.doesNotMatch(html, /Automatic publishing|Approval required|<details/);
});
