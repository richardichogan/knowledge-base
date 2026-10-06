import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRIMARY_DESTINATIONS, TOOL_GROUPS, matchesDestination, selectedTool } from '../src/navigation/destinations';

test('primary workspaces retain their routes including GitHub Build', () => {
  assert.deepEqual(PRIMARY_DESTINATIONS.map((item) => [item.label, item.path]), [
    ['Today', '/'], ['Discover', '/discover'], ['Plan', '/plan'], ['Think', '/think'], ['Build', '/build'], ['Projects', '/projects'],
  ]);
  assert.ok(!matchesDestination('/graph', '/'));
  assert.ok(matchesDestination('/think', '/think'));
  assert.ok(matchesDestination('/think/editor', '/think'));
  assert.ok(!matchesDestination('/thinking', '/think'));
});

test('supporting records, configuration and management are separated without losing destinations', () => {
  assert.deepEqual(TOOL_GROUPS.map((group) => group.label), ['Context and records', 'Athena configuration', 'Management']);
  assert.deepEqual(TOOL_GROUPS[0]!.items.map((item) => [item.label, item.path]), [
    ['Activity', '/my-work'], ['Sources', '/library'], ['Knowledge graph', '/graph'],
  ]);
  assert.equal(selectedTool('/memory', '')?.label, 'Memory');
  assert.equal(selectedTool('/my-work', '')?.label, 'Activity');
  assert.equal(selectedTool('/my-work', '?sync=1')?.label, 'Connections and sync');
  assert.equal(selectedTool('/library', '')?.label, 'Sources');
  assert.equal(selectedTool('/settings/repo-mappings', '')?.id, 'repo-projects');
  assert.equal(selectedTool('/think', '?noteId=note')?.id, undefined);
  assert.ok(TOOL_GROUPS.flatMap((group) => group.items).every((item) => item.description && (item.path || item.action)));
});
