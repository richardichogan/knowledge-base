import { api } from './api';
import { getDesktop, type DesktopFileInfo } from '../types/desktop';
import type { JobRun } from '../types/jobs';

interface DesktopAssignment { managedImport: boolean; work: { run: JobRun; lease: string } | null }
export async function syncDesktopJobs(files: DesktopFileInfo[], onCompleted?: () => void): Promise<boolean> {
  const desktop = getDesktop();
  if (!desktop) return false;
  const device = await desktop.device();
  const folders = await desktop.listFolders();
  const assignment = await api.jobs<DesktopAssignment>('/desktop/claim', 'POST', { ...device, folders });
  if (!assignment.work) return assignment.managedImport;
  const { run, lease } = assignment.work;
  const finish = (result: Record<string, unknown>): Promise<unknown> => api.jobs(`/desktop/${run.id}/result`, 'POST', { deviceId: device.deviceId, lease, ...result });
  let result: Record<string, unknown>;
  try {
    const d = run.definition;
    if (typeof desktop.readText !== 'function' || (d.kind !== 'm365-import' && typeof desktop.writeText !== 'function')) throw new Error('Update Athena Desktop to use scheduled file jobs.');
    const root = d.kind === 'm365-import' ? d.inputFolder : d.outputFolder;
    if (!folders.some(f => f.path === root)) throw new Error('This job folder is no longer authorised on this device. Update the job or grant access through Library.');
    const separator = root.includes('\\') ? '\\' : '/';
    const join = (name: string): string => `${root.replace(/[\\/]$/, '')}${separator}${name}`;
    if (d.kind === 'm365-import') {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: d.schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(run.scheduledAt));
      const part = (name: string): string => parts.find(p => p.type === name)!.value;
      const filename = `Daily-Briefing-${part('year')}-${part('month')}-${part('day')}.md`;
      const normal = (path: string): string => path.replace(/\\/g, '/').toLowerCase();
      const file = files.find(f => normal(f.path) === normal(join(filename)));
      const content = file ? await desktop.readText(file.path) : null;
      result = content === null || !file ? { waiting: true } : { filename, text: content, modifiedAt: file.modifiedAt };
    } else {
      const markdown = run.artifacts.markdown;
      if (typeof markdown !== 'string') throw new Error('The job has no generated Markdown output.');
      const path = join(`athena-${run.id}.md`);
      const existing = await desktop.readText(path);
      if (existing !== null && existing !== markdown) throw new Error('The run output file already exists with different content. Athena will not overwrite it.');
      if (existing === null) await desktop.writeText(path, markdown);
      result = { path };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Desktop job failed';
    await finish({ error: message });
    throw error;
  }
  await finish(result);
  if (result.waiting !== true) onCompleted?.();
  return assignment.managedImport;
}
