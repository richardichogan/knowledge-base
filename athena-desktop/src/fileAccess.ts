/** File operations behind the desktop bridge. Every path is checked against the allowed folders first. */
import { promises as fs } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { guardPath, type LocalFolder } from './folders';
import { MAX_FILE_BYTES } from './scanner';

/** Files Athena may create or overwrite (text only — Office files and PDFs are read-only). */
export const WRITABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml', '.html', '.css', '.ts', '.tsx', '.js', '.jsx', '.py', '.ps1', '.xml']);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

export interface FileBytes {
  name: string;
  path: string;
  data: Uint8Array;
}

export async function readFileBytes(path: string, folders: LocalFolder[]): Promise<FileBytes> {
  const safe = await guardPath(path, folders);
  const stat = await fs.stat(safe);
  if (!stat.isFile()) throw new Error(`"${path}" is not a file.`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`"${basename(safe)}" is larger than 50 MB.`);
  return { name: basename(safe), path: safe, data: new Uint8Array(await fs.readFile(safe)) };
}

/** The file's text, or null if it does not exist yet (a new file). */
export async function readText(path: string, folders: LocalFolder[]): Promise<string | null> {
  const safe = await guardPath(path, folders);
  try {
    const stat = await fs.stat(safe);
    if (stat.size > MAX_TEXT_BYTES) throw new Error(`"${basename(safe)}" is too large to show as text.`);
    return await fs.readFile(safe, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes via a temporary file so a failure never leaves a half-written file. */
export async function writeText(path: string, content: string, folders: LocalFolder[]): Promise<void> {
  if (typeof content !== 'string') throw new Error('File content must be text.');
  const safe = await guardPath(path, folders);
  if (!WRITABLE_EXTENSIONS.has(extname(safe).toLowerCase())) {
    throw new Error(`Athena can only write text files, not ${extname(safe) || 'files without an extension'}.`);
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw new Error('The new content is larger than 5 MB.');
  await fs.mkdir(dirname(safe), { recursive: true });
  const tmp = `${safe}.athena-${process.pid.toString()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, safe);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
