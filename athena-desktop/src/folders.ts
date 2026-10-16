/**
 * The folders Athena may use on this PC, and the checks every file path goes through.
 * Only the main process touches the disk; the web page asks for files by path and
 * each path must resolve inside a folder the user added.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

export interface LocalFolder {
  id: string;
  name: string;
  path: string;
}

export interface FolderStore {
  deviceId: string;
  folders: LocalFolder[];
}

/** Case-insensitive on Windows, like the file system. */
export function comparablePath(p: string): string {
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(child: string, root: string): boolean {
  const c = comparablePath(child);
  const r = comparablePath(root);
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** The folder a file path is inside (after resolving `..`), or null. A folder's own path is not a file inside it. */
export function folderContaining(filePath: string, folders: LocalFolder[]): LocalFolder | null {
  if (typeof filePath !== 'string' || filePath.trim() === '' || !isAbsolute(filePath)) return null;
  return folders.find((f) => isWithin(filePath, f.path)) ?? null;
}

/** Resolves the path and confirms it is inside an allowed folder, following symlinks/junctions (for a new file, through its nearest existing parent). */
export async function guardPath(filePath: string, folders: LocalFolder[]): Promise<string> {
  if (folderContaining(filePath, folders) === null) throw new Error(`Athena does not have access to "${String(filePath)}".`);
  const resolved = resolve(filePath);
  let existing = resolved;
  let real = await realpathIfExists(existing);
  while (real === null && dirname(existing) !== existing) {
    existing = dirname(existing);
    real = await realpathIfExists(existing);
  }
  if (real !== null) {
    const target = real;
    const isNewFile = existing !== resolved;
    const realRoots = await Promise.all(folders.map(async (f) => (await realpathIfExists(f.path)) ?? f.path));
    const inside = realRoots.some((root) => isWithin(target, root) || (isNewFile && comparablePath(target) === comparablePath(root)));
    if (!inside) throw new Error(`"${filePath}" links outside the folders Athena can use.`);
  }
  return resolved;
}

async function realpathIfExists(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The id the server stores this file under: `<deviceId>:<sha256 of the lower-cased absolute path>`. */
export function localKey(deviceId: string, filePath: string): string {
  return `${deviceId}:${createHash('sha256').update(resolve(filePath).toLowerCase()).digest('hex')}`;
}

export class FolderRegistry {
  private store: FolderStore | null = null;

  public constructor(private readonly file: string) {}

  public async load(): Promise<FolderStore> {
    if (this.store !== null) return this.store;
    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (raw === null) {
      this.store = { deviceId: randomUUID(), folders: [] };
      await this.save();
      return this.store;
    }
    const parsed = JSON.parse(raw) as Partial<FolderStore>;
    if (typeof parsed.deviceId !== 'string' || !Array.isArray(parsed.folders)) throw new Error(`${this.file} is not a valid folder list.`);
    this.store = { deviceId: parsed.deviceId, folders: parsed.folders.filter(isFolder) };
    return this.store;
  }

  public async folders(): Promise<LocalFolder[]> {
    return [...(await this.load()).folders];
  }

  public async add(folderPath: string): Promise<LocalFolder> {
    const store = await this.load();
    const path = resolve(folderPath);
    const stat = await fs.stat(path);
    if (!stat.isDirectory()) throw new Error(`"${path}" is not a folder.`);
    const existing = store.folders.find((f) => comparablePath(f.path) === comparablePath(path));
    if (existing !== undefined) return existing;
    const overlap = store.folders.find((f) => isWithin(path, f.path) || isWithin(f.path, path));
    if (overlap !== undefined) throw new Error(`"${path}" overlaps "${overlap.path}", which Athena already uses. Remove that one first.`);
    const folder: LocalFolder = { id: randomUUID(), name: basename(path) || path, path };
    store.folders.push(folder);
    await this.save();
    return folder;
  }

  public async remove(id: string): Promise<LocalFolder | null> {
    const store = await this.load();
    const folder = store.folders.find((f) => f.id === id) ?? null;
    if (folder === null) return null;
    store.folders = store.folders.filter((f) => f.id !== id);
    await this.save();
    return folder;
  }

  private async save(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.store, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }
}

function isFolder(f: unknown): f is LocalFolder {
  const o = f as Partial<LocalFolder> | null;
  return o !== null && typeof o === 'object' && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.path === 'string' && isAbsolute(o.path);
}
