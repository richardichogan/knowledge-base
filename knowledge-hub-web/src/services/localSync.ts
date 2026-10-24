/**
 * Keeps the files in Athena Desktop's local folders indexed in Athena (Azure)
 * while the app is open: uploads new and changed files, removes deleted ones.
 * Every problem is kept in the status so the Library shows it.
 */
import { api } from './api';
import { describeApiError, requireApiData } from './apiError';
import type { ApiResponse } from '../types/apiResponse';
import { desktopErrorMessage, getDesktop, type DesktopSkippedFile } from '../types/desktop';
import { dailyInsightsFiles } from './dailyInsightsSource';
import { syncDesktopJobs } from './desktopJobs';

export interface DailyInsightsSyncReport {
  path: string;
  date: string;
  knowledgeDate: string;
  tasksCreated: number;
  tasksUpdated: number;
  tasksPreserved: number;
  meetings: number;
  warnings: string[];
  unchanged: boolean;
}

export interface LocalSyncProblem {
  path: string;
  message: string;
}

export interface LocalSyncStatus {
  running: boolean;
  /** "Uploading 3 of 12" while running. */
  progress: string | null;
  lastSyncAt: string | null;
  indexed: number;
  uploaded: number;
  removed: number;
  /** Files the desktop app could not read or that are not indexable (too large, over the limit). */
  skipped: DesktopSkippedFile[];
  /** Files that failed to upload or remove, and a sync-level error. */
  problems: LocalSyncProblem[];
  error: string | null;
  dailyInsights: DailyInsightsSyncReport[];
}

const UPLOAD_CONCURRENCY = 3;

let status: LocalSyncStatus = { running: false, progress: null, lastSyncAt: null, indexed: 0, uploaded: 0, removed: 0, skipped: [], problems: [], error: null, dailyInsights: [] };
const listeners = new Set<() => void>();
let again = false;
let started = false;
let onSynced: (() => void) | null = null;

function set(patch: Partial<LocalSyncStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((l) => { l(); });
}

export function getLocalSyncStatus(): LocalSyncStatus {
  return status;
}

export function subscribeLocalSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Index entries are kept for paths the scan skipped (unreadable folders, files over a limit). */
function coveredBySkipped(path: string, skipped: DesktopSkippedFile[]): boolean {
  const p = path.toLowerCase();
  return skipped.some((s) => {
    const k = s.path.toLowerCase();
    return p === k || p.startsWith(k.endsWith('\\') ? k : `${k}\\`);
  });
}

async function apiCall<T>(call: () => Promise<ApiResponse<T>>): Promise<T> {
  try {
    return requireApiData(await call());
  } catch (err) {
    throw new Error(describeApiError(err));
  }
}

/** Runs a sync now (or straight after the one in progress). */
export async function syncLocalFolders(): Promise<void> {
  const desktop = getDesktop();
  if (desktop === null) return;
  if (status.running) {
    again = true;
    return;
  }
  set({ running: true, progress: 'Looking for changes', error: null });
  const problems: LocalSyncProblem[] = [];
  try {
    const { deviceId, deviceName } = await desktop.device();
    const scan = await desktop.scan();
    const folders = await desktop.listFolders();
    const reports: DailyInsightsSyncReport[] = [];
    let captured = false;
    let managedImport = true;
    try { managedImport = await syncDesktopJobs(scan.files, () => { onSynced?.(); }); }
    catch (error) { problems.push({ path: 'Scheduled desktop jobs', message: desktopErrorMessage(error) }); }
    // Always retry structured capture, even when the upload index already has this hash.
    // The server's transactional ledger, not this browser, owns durable deduplication.
    for (const file of managedImport ? [] : dailyInsightsFiles(scan.files, folders)) {
      set({ progress: `Processing Daily Insights: ${file.path.split('\\').pop() ?? file.path}` });
      try {
        if (file.size > 1_000_000) throw new Error('Daily Insights report exceeds the capture size limit');
        const text = await desktop.readText(file.path);
        if (text === null) throw new Error('Report disappeared while syncing; will retry');
        const filename = file.path.split('\\').pop() ?? '';
        const result = await apiCall(() => api.captureDailyInsights({ filename, text, sourcePath: file.path, sourceModifiedAt: file.modifiedAt }));
        reports.push({ path: file.path, ...result });
        captured ||= !result.unchanged;
      } catch (err) {
        problems.push({ path: file.path, message: `Daily Insights capture failed (will retry): ${desktopErrorMessage(err)}` });
      }
    }
    set({ dailyInsights: reports, problems });
    if (captured) onSynced?.();
    const indexed = await apiCall(() => api.getLocalIndex(deviceId));
    const byKey = new Map(indexed.map((e) => [e.localKey, e]));
    const changed = scan.files.filter((f) => byKey.get(f.localKey)?.localHash !== f.hash);
    const present = new Set(scan.files.map((f) => f.localKey));
    const gone = indexed.filter((e) => !present.has(e.localKey) && !coveredBySkipped(e.localPath, scan.skipped));

    let done = 0;
    let uploaded = 0;
    const queue = [...changed];
    const worker = async (): Promise<void> => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        set({ progress: `Indexing ${(done + 1).toString()} of ${changed.length.toString()}` });
        try {
          const bytes = await desktop.readFile(file.path);
          // Copy into a fresh ArrayBuffer: the IPC result may be a view over a larger shared buffer.
          const blob = new File([bytes.data.slice().buffer], bytes.name);
          await apiCall(() => api.uploadLocalDocument(blob, { localKey: file.localKey, localPath: file.path, localHash: file.hash, deviceName }));
          uploaded += 1;
        } catch (err) {
          problems.push({ path: file.path, message: desktopErrorMessage(err) });
        }
        done += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, changed.length) }, worker));

    let removed = 0;
    if (gone.length > 0) {
      set({ progress: `Removing ${gone.length.toString()} deleted file${gone.length === 1 ? '' : 's'}` });
      try {
        removed = (await apiCall(() => api.removeLocalDocuments(gone.map((g) => g.localKey)))).removed;
      } catch (err) {
        problems.push({ path: gone.map((g) => g.localPath).join(', '), message: `Could not remove from the index: ${desktopErrorMessage(err)}` });
      }
    }
    set({
      lastSyncAt: new Date().toISOString(),
      indexed: scan.files.length - (changed.length - uploaded),
      uploaded,
      removed,
      skipped: scan.skipped,
      problems,
    });
    if (uploaded > 0 || removed > 0) onSynced?.();
  } catch (err) {
    set({ error: desktopErrorMessage(err), problems });
  } finally {
    set({ running: false, progress: null });
  }
  if (again) {
    again = false;
    await syncLocalFolders();
  }
}

/** Starts syncing on launch and whenever files change. Safe to call more than once. */
export function startLocalSync(afterSync: () => void): () => void {
  const desktop = getDesktop();
  onSynced = afterSync;
  if (desktop === null || started) return () => undefined;
  started = true;
  void syncLocalFolders();
  const stop = desktop.onFilesChanged(() => { void syncLocalFolders(); });
  // Watch events can be missed by OneDrive; failures also need retries without a file edit.
  const timer = window.setInterval(() => { void syncLocalFolders(); }, 60_000);
  return () => {
    stop();
    window.clearInterval(timer);
    started = false;
  };
}
