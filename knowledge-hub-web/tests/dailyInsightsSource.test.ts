import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyInsightsFiles, isDailyInsightsFile } from '../src/services/dailyInsightsSource';
import type { DesktopFileInfo, DesktopFolder } from '../src/types/desktop';

const folder: DesktopFolder = { id: 'a', path: 'C:\\Reports', name: 'Reports' };
const file = (path: string): DesktopFileInfo => ({ path, folderId: 'a', hash: 'a', localKey: path, size: 100, modifiedAt: '2026-10-20T08:00:00Z' });

test('only the exact authorised path or explicitly opted-in source creates structured captures', () => {
  assert.equal(isDailyInsightsFile(file('C:\\Reports\\Daily-Briefing-2026-10-20.md'), [folder]), false);
  assert.equal(isDailyInsightsFile(file('C:\\Users\\RichardHogan\\OneDrive - IBM\\Daily Insights\\Daily-Briefing-2026-10-20.md'), [folder]), true);
  assert.equal(isDailyInsightsFile(file('C:\\Other\\Daily Insights\\Daily-Briefing-2026-10-20.md'), [folder]), false);
  assert.equal(isDailyInsightsFile(file('C:\\Reports\\Daily-Briefing-2026-10-20.md'), [{ ...folder, source: 'daily-insights' }]), true);
  assert.equal(isDailyInsightsFile(file('C:\\Reports\\random.md'), [{ ...folder, source: 'daily-insights' }]), false);
});

test('processes report dates oldest to newest regardless of directory scan order', () => {
  const files = dailyInsightsFiles([file('C:\\Reports\\Daily-Briefing-2026-10-21.md'), file('C:\\Reports\\Daily-Briefing-2026-10-20.md')], [{ ...folder, source: 'daily-insights' }]);
  assert.match(files[0]?.path ?? '', /2026-10-20/);
});

test('takes only the latest corrected copy for a report date, retaining the originals', () => {
  const older = file('C:\\Reports\\old\\Daily-Briefing-2026-10-20.md');
  const newer = { ...file('C:\\Reports\\Daily-Briefing-2026-10-20.md'), modifiedAt: '2026-10-20T10:00:00Z' };
  const files = [newer, older];
  assert.deepEqual(dailyInsightsFiles(files, [{ ...folder, source: 'daily-insights' }]), [newer]);
  assert.equal(files.length, 2);
});
