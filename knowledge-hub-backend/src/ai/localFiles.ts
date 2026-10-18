/**
 * Chat tools for files in folders on the user's PC (Athena Desktop only).
 *
 * The server never touches the PC: reads come from the indexed copy of the file,
 * and writes are proposals that the desktop app shows as a diff and writes only
 * when the user applies them (it checks the path against its own folder list again).
 */
import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';

/** A folder Athena Desktop has been given access to (sent with each chat turn). */
export interface LocalFolder {
  name: string;
  path: string;
}

export interface LocalFileWriteProposal {
  path: string;
  content: string;
  summary: string;
}

const MAX_FOLDERS = 50;
const MAX_WRITE_CHARS = 200_000;
const READ_MAX_CHARS = 50_000;
const UNC_ROOT_SEGMENTS = 2;
const DRIVE_ROOT_SEGMENTS = 1;
const WRITABLE_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'yaml', 'yml', 'html', 'css', 'ts', 'tsx', 'js', 'jsx', 'py', 'ps1', 'xml']);

export const LOCAL_FILE_TOOL_NAMES = new Set(['read_local_file', 'propose_local_file_write']);

/** The folders from a chat request, or [] when the request did not come from Athena Desktop. */
export function parseLocalFolders(value: unknown): LocalFolder[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((f): f is { name: unknown; path: unknown } => typeof f === 'object' && f !== null)
    .map((f) => ({ name: typeof f.name === 'string' ? f.name.trim() : '', path: typeof f.path === 'string' ? f.path.trim() : '' }))
    .filter((f) => f.path !== '' && isAbsoluteWindowsPath(f.path))
    .slice(0, MAX_FOLDERS)
    .map((f) => ({ name: f.name || f.path, path: f.path }));
}

function isAbsoluteWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** Lower-cased, backslash-separated, no trailing separator, with `.` and `..` resolved; null if it escapes the root. */
export function normaliseWindowsPath(p: string): string | null {
  const unc = p.startsWith('\\\\') || p.startsWith('//');
  const parts = p.replace(/\//g, '\\').split('\\').slice(unc ? UNC_ROOT_SEGMENTS : 0);
  // A drive root (C:) or UNC share (\\server\share) cannot be climbed out of.
  const rootSegments = unc ? UNC_ROOT_SEGMENTS : DRIVE_ROOT_SEGMENTS;
  const segments: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length <= rootSegments) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length < rootSegments) return null;
  return ((unc ? '\\\\' : '') + segments.join('\\')).toLowerCase();
}

/** The folder a path is inside, or null. A folder's own path does not count as a file inside it. */
export function folderFor(filePath: string, folders: LocalFolder[]): LocalFolder | null {
  const file = normaliseWindowsPath(filePath);
  if (file === null || !isAbsoluteWindowsPath(filePath)) return null;
  for (const folder of folders) {
    const root = normaliseWindowsPath(folder.path);
    if (root !== null && file.startsWith(`${root}\\`)) return folder;
  }
  return null;
}

export function localFilesPrompt(folders: LocalFolder[]): string {
  if (folders.length === 0) return '';
  return [
    '## Folders on his PC (Athena Desktop)',
    'He is using Athena Desktop, which has access to these folders on his PC. Their supported files are indexed into the ' +
      'knowledge base (search_knowledge_base finds them), and read_local_file reads one by its full path.',
    ...folders.map((f) => `- ${f.name}: ${f.path}`),
    'To create or change a file in these folders, call propose_local_file_write with its full path and the COMPLETE new ' +
      'contents. He sees a diff and the file is only written when he applies it, so never say a file was written or changed ' +
      'until he has applied it. Only text files can be written. Read an existing file first so unchanged parts are kept.',
  ].join('\n');
}

export const LOCAL_FILE_TOOLS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_local_file',
      description: "Reads a file from one of the folders on his PC that Athena Desktop has access to (listed under 'Folders on his PC'), by its full path. Returns the indexed text of the file.",
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Full path of the file, e.g. C:\\Users\\Richard\\Documents\\Notes\\plan.md' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_local_file_write',
      description: 'Proposes creating or overwriting a text file in one of the folders on his PC. He reviews a diff and the file is written only when he applies it. Give the COMPLETE new file contents, not a fragment.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Full path of the file to create or replace, inside one of the listed folders.' },
          content: { type: 'string', description: 'The complete new contents of the file.' },
          summary: { type: 'string', description: 'One short line describing the change, e.g. "Add a risks section to plan.md".' },
        },
        required: ['path', 'content', 'summary'],
      },
    },
  },
];

export async function executeLocalFileTool(
  db: Pool,
  name: string,
  args: Record<string, unknown>,
  folders: LocalFolder[],
  writes: LocalFileWriteProposal[] | undefined,
): Promise<unknown> {
  if (folders.length === 0) return { error: 'Local files are only available in Athena Desktop.' };
  const path = typeof args['path'] === 'string' ? args['path'].trim() : '';
  if (folderFor(path, folders) === null) {
    return { error: `"${path}" is not inside a folder Athena Desktop has access to. Use a full path inside one of: ${folders.map((f) => f.path).join('; ')}` };
  }
  if (name === 'read_local_file') {
    const target = normaliseWindowsPath(path);
    const { rows } = await db.query<{ id: string; title: string; body: string | null; local_path: string }>(
      `SELECT id, title, body, metadata->>'localPath' AS local_path FROM content_items
       WHERE source = 'user-upload' AND source_id LIKE 'local:%' AND lower(replace(metadata->>'localPath', '/', '\\')) = $1
       ORDER BY updated_at DESC LIMIT 1`,
      [target],
    );
    const row = rows[0];
    if (row === undefined) {
      return { error: `"${path}" has not been indexed. Only supported files (PDF, Word, PowerPoint, Excel, CSV, Markdown, text) in the folders are indexed, and new files take a moment to appear.` };
    }
    const body = row.body ?? '';
    return { path: row.local_path, title: row.title, contentItemId: row.id, text: body.slice(0, READ_MAX_CHARS), truncated: body.length > READ_MAX_CHARS };
  }
  if (name === 'propose_local_file_write') {
    const content = typeof args['content'] === 'string' ? args['content'] : '';
    const summary = typeof args['summary'] === 'string' && args['summary'].trim() !== '' ? args['summary'].trim() : 'Update file';
    const ext = path.toLowerCase().split('.').pop() ?? '';
    if (!WRITABLE_EXTENSIONS.has(ext)) return { error: `Only text files can be written (${[...WRITABLE_EXTENSIONS].join(', ')}), not .${ext}.` };
    if (content.length > MAX_WRITE_CHARS) return { error: `The file is too long to propose in one go (over ${MAX_WRITE_CHARS.toString()} characters).` };
    writes?.push({ path, content, summary });
    return { proposed: true, path, note: 'Shown to him as a diff with Apply/Discard. It is not written until he applies it.' };
  }
  return { error: `Unknown local file tool ${name}` };
}
