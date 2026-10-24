import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRIMARY_DESTINATIONS, TOOL_GROUPS, matchesDestination, selectedTool } from '../src/navigation/destinations';
import { settingsBackground, settingsLinkState, settingsView } from '../src/navigation/settings';
import type { Location } from 'react-router-dom';
import { scheduleLabel, statusLabel } from '../src/components/jobs/jobPresentation';

test('primary workspaces retain their routes including GitHub Build', () => {
  assert.deepEqual(PRIMARY_DESTINATIONS.map((item) => [item.label, item.path]), [
    ['Today', '/'], ['Discover', '/discover'], ['Plan', '/plan'], ['Think', '/think'], ['Build', '/build'],
  ]);
  assert.ok(!matchesDestination('/graph', '/'));
  assert.ok(matchesDestination('/think', '/think'));
  assert.ok(matchesDestination('/think/editor', '/think'));
  assert.ok(!matchesDestination('/thinking', '/think'));
});

test('configuration routes open settings dialogs while working destinations stay pages', () => {
  assert.equal(settingsView('/memory'), 'memory');
  assert.equal(settingsView('/settings/repo-mappings'), 'repo-projects');
  assert.equal(settingsView('/my-work', '?sync=1'), 'sync');
  for (const path of ['/people', '/companies', '/library', '/graph', '/projects', '/health', '/my-work']) {
    assert.equal(settingsView(path), undefined, path);
  }
  assert.equal(settingsView('/my-work', '?sync=0'), undefined);
});

test('settings navigation preserves the exact workspace location, including unsaved route state', () => {
  const workspace: Location = {
    pathname: '/think', search: '?noteId=note-1', hash: '#paragraph-2',
    key: 'workspace-entry', state: { editor: 'keep-open' },
  };
  const modal: Location = {
    pathname: '/memory', search: '', hash: '', key: 'settings-entry',
    state: settingsLinkState(workspace),
  };
  assert.deepEqual(settingsBackground(modal), workspace);
  assert.equal(settingsBackground({ ...modal, state: null }), undefined, 'direct links have no previous workspace');
  assert.equal(settingsBackground({ ...modal, state: { settingsBackground: '/think' } }), undefined);
  assert.equal(settingsBackground({ ...modal, state: settingsLinkState(modal) }), undefined, 'do not nest settings as workspaces');
  assert.equal(settingsBackground({ ...modal, state: settingsLinkState({ ...workspace, pathname: '//elsewhere' }) }), undefined);
  const jobs = { ...modal, pathname: '/jobs', search: '?jobId=job-1&runId=run-1' };
  assert.deepEqual(settingsBackground(jobs), workspace, 'a job run opens without replacing the underlying workspace');
  assert.deepEqual(settingsBackground({ ...jobs, search: '?jobId=job-2' }), workspace, 'filtering history keeps the return location');
});

test('supporting records, configuration and management are separated without losing destinations', () => {
  assert.deepEqual(TOOL_GROUPS.map((group) => group.label), ['Context and records', 'Athena configuration', 'Management']);
  assert.deepEqual(TOOL_GROUPS[0]!.items.map((item) => [item.label, item.path]), [
    ['People', '/people'], ['Companies', '/companies'], ['Activity', '/my-work'], ['Sources', '/library'], ['Knowledge graph', '/graph'],
  ]);
  assert.equal(selectedTool('/memory', '')?.label, 'Memory');
  assert.equal(selectedTool('/people', '?personId=abc')?.label, 'People');
  assert.equal(selectedTool('/companies', '?companyId=abc')?.label, 'Companies');
  assert.equal(selectedTool('/projects', '')?.label, 'Projects');
  assert.equal(selectedTool('/jobs', '')?.label, 'Jobs');
  assert.equal(settingsView('/jobs'), 'jobs', 'Jobs opens over the current workspace');
  assert.equal(settingsView('/jobs', '?jobId=job-1&runId=run-1'), 'jobs', 'run deep links retain the modal');
  assert.equal(TOOL_GROUPS[2]!.items.find((item) => item.id === 'projects')?.path, '/projects');
  assert.equal(selectedTool('/my-work', '')?.label, 'Activity');
  assert.equal(selectedTool('/my-work', '?sync=1')?.label, 'Connections and sync');
  assert.equal(selectedTool('/library', '')?.label, 'Sources');
  assert.equal(selectedTool('/settings/repo-mappings', '')?.id, 'repo-projects');
  assert.equal(selectedTool('/think', '?noteId=note')?.id, undefined);
  assert.ok(TOOL_GROUPS.flatMap((group) => group.items).every((item) => item.description && (item.path || item.action)));
});

test('job schedule labels condense common frequencies without hiding custom days or times', () => {
  const schedule = { timezone: 'Europe/London', days: [6, 5, 4, 3, 2, 1, 0], times: ['06:00', '13:00'] };
  assert.equal(scheduleLabel(schedule), 'Every day at 06:00 & 13:00');
  assert.equal(scheduleLabel({ ...schedule, days: [1, 2, 3, 4, 5] }), 'Weekdays at 06:00 & 13:00');
  assert.equal(scheduleLabel({ ...schedule, days: [5, 1] }), 'Mon, Fri at 06:00 & 13:00');
  assert.equal(statusLabel('awaiting-approval'), 'Needs approval');
  assert.equal(statusLabel('waiting-device'), 'Waiting for desktop');
  assert.equal(statusLabel('running'), 'Running');
});
