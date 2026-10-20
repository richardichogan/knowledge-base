import type { DesktopFileInfo, DesktopFolder } from '../types/desktop';

const AUTHORISED_FOLDER = 'c:\\users\\richardhogan\\onedrive - ibm\\daily insights';
const normalPath = (path: string): string => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** The named source is explicit opt-in; the exact path was separately authorised by Richard. */
export function isDailyInsightsFile(file: DesktopFileInfo, folders: DesktopFolder[]): boolean {
  const path = normalPath(file.path);
  const folder = folders.find(f => f.id === file.folderId);
  return /^daily-briefing-\d{4}-\d{2}-\d{2}\.md$/i.test(path.slice(path.lastIndexOf('\\') + 1))
    && (folder?.source === 'daily-insights' || path.slice(0, path.lastIndexOf('\\')) === AUTHORISED_FOLDER);
}

export function dailyInsightsFiles(files: DesktopFileInfo[], folders: DesktopFolder[]): DesktopFileInfo[] {
  const name = (path: string): string => path.slice(path.lastIndexOf('\\') + 1).toLowerCase();
  const latest = new Map<string, DesktopFileInfo>();
  for (const file of files.filter(f => isDailyInsightsFile(f, folders))) {
    const key = name(file.path);
    const prior = latest.get(key);
    if (prior === undefined || file.modifiedAt > prior.modifiedAt
      || (file.modifiedAt === prior.modifiedAt && file.path > prior.path)) latest.set(key, file);
  }
  return [...latest.values()].sort((a, b) => name(a.path).localeCompare(name(b.path)));
}
