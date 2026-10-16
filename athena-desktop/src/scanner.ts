/** Finds the files in the allowed folders that Athena indexes, with a content hash for change detection. */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import { localKey, type LocalFolder } from './folders';

/** The same types the server's /documents/upload accepts. */
export const INDEXED_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.md', '.markdown', '.txt']);
/** The server's upload limit. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** More than this in one scan is reported, not silently dropped. */
export const MAX_FILES = 5_000;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information']);

export interface LocalFileInfo {
  path: string;
  folderId: string;
  localKey: string;
  hash: string;
  size: number;
  modifiedAt: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ScanResult {
  files: LocalFileInfo[];
  skipped: SkippedFile[];
}

interface CachedHash { size: number; mtimeMs: number; hash: string }

export function isIndexable(name: string): boolean {
  // Office keeps "~$name.docx" lock files beside open documents.
  return !name.startsWith('~$') && INDEXED_EXTENSIONS.has(extname(name).toLowerCase());
}

export class Scanner {
  private readonly hashes = new Map<string, CachedHash>();

  public async scan(deviceId: string, folders: LocalFolder[]): Promise<ScanResult> {
    const files: LocalFileInfo[] = [];
    const skipped: SkippedFile[] = [];
    for (const folder of folders) {
      await this.walk(folder, folder.path, deviceId, files, skipped);
    }
    return { files, skipped };
  }

  private async walk(folder: LocalFolder, dir: string, deviceId: string, files: LocalFileInfo[], skipped: SkippedFile[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dir, reason: `Could not open the folder: ${(err as Error).message}` });
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        await this.walk(folder, full, deviceId, files, skipped);
        continue;
      }
      if (!entry.isFile() || !isIndexable(entry.name)) continue;
      if (files.length >= MAX_FILES) {
        skipped.push({ path: full, reason: `Over the ${MAX_FILES.toString()} file limit` });
        continue;
      }
      try {
        const stat = await fs.stat(full);
        if (stat.size > MAX_FILE_BYTES) {
          skipped.push({ path: full, reason: 'Larger than 50 MB' });
          continue;
        }
        if (stat.size === 0) continue;
        files.push({
          path: full,
          folderId: folder.id,
          localKey: localKey(deviceId, full),
          hash: await this.hash(full, stat.size, stat.mtimeMs),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch (err) {
        skipped.push({ path: full, reason: `Could not read the file: ${(err as Error).message}` });
      }
    }
  }

  private async hash(path: string, size: number, mtimeMs: number): Promise<string> {
    const cached = this.hashes.get(path);
    if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs) return cached.hash;
    const hash = await new Promise<string>((ok, fail) => {
      const h = createHash('sha256');
      createReadStream(path).on('data', (chunk) => h.update(chunk)).on('end', () => ok(h.digest('hex'))).on('error', fail);
    });
    this.hashes.set(path, { size, mtimeMs, hash });
    return hash;
  }
}
