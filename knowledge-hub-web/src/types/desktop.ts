/**
 * Athena Desktop bridge — present as `window.athenaDesktop` only when Athena
 * runs inside the desktop app (athena-desktop/src/preload.ts). Every file path
 * is checked against the user's chosen folders in the desktop app itself.
 */

export interface DesktopFolder {
  id: string;
  name: string;
  path: string;
}

export interface DesktopFileInfo {
  path: string;
  folderId: string;
  localKey: string;
  hash: string;
  size: number;
  modifiedAt: string;
}

export interface DesktopSkippedFile {
  path: string;
  reason: string;
}

export interface AthenaDesktopBridge {
  version: string;
  device(): Promise<{ deviceId: string; deviceName: string }>;
  listFolders(): Promise<DesktopFolder[]>;
  /** Opens a folder picker; null when cancelled. */
  addFolder(): Promise<DesktopFolder | null>;
  removeFolder(id: string): Promise<DesktopFolder | null>;
  scan(): Promise<{ files: DesktopFileInfo[]; skipped: DesktopSkippedFile[] }>;
  readFile(path: string): Promise<{ name: string; path: string; data: Uint8Array }>;
  /** The file's text, or null when it does not exist yet. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  /** Opens a file picker inside the allowed folders; null when cancelled. */
  pickFile(): Promise<string | null>;
  /** Called (debounced) when files in the folders change. Returns an unsubscribe. */
  onFilesChanged(listener: () => void): () => void;
  /** Desktop 0.1.3+: an Athena `/chat?…` link opened elsewhere, to show in this chat window. */
  onOpenChat?(listener: (path: string) => void): () => void;
}

declare global {
  interface Window {
    athenaDesktop?: AthenaDesktopBridge;
  }
}

/** The desktop bridge, or null in a normal browser / the PWA. */
export function getDesktop(): AthenaDesktopBridge | null {
  return typeof window !== 'undefined' && window.athenaDesktop !== undefined ? window.athenaDesktop : null;
}

/** Electron wraps errors from the main process as "Error invoking remote method 'x': Error: message". */
export function desktopErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
