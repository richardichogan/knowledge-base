/**
 * integrations/alliance/oneDriveUpload.ts — documents attached in chat are
 * saved to OneDrive (<root>/Chat uploads/<Project>/…) and indexed straight
 * away with the same extraction the OneDrive sync uses, so Athena can answer
 * about them at once and the next sync recognises them as already indexed.
 */

import type { Pool } from 'pg';
import { env } from '../../config/env.js';
import { ValidationError } from '../../types/errors.js';
import { allianceUploadFile, getAllianceStatus, isAllianceConfigured } from './allianceGraph.js';
import { CHAT_UPLOADS_FOLDER, ONEDRIVE_MAX_FILE_BYTES, extractFileText, saveDriveDocument } from './oneDriveSync.js';

/** OneDrive can't take the file right now (not set up, signed out, or no upload permission). */
export class OneDriveUnavailableError extends Error {}

export interface ChatUploadResult {
  contentItemId: string;
  driveItemId: string;
  filename: string;
  /** Path under the OneDrive root, e.g. "Chat uploads/IMAGINE/Plan.docx". */
  path: string;
  url: string;
  text: string;
  warning?: string;
}

// Characters OneDrive does not allow in file or folder names.
function safeName(name: string, fallback: string): string {
  const cleaned = name.replace(/["*:<>?/\\|]/g, '-').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned === '' ? fallback : cleaned;
}

/** Folder under "Chat uploads" for a project; Personal uploads sit directly in it. */
export function chatUploadFolder(project: { id: string; name: string }): string {
  return project.id === 'personal' ? CHAT_UPLOADS_FOLDER : `${CHAT_UPLOADS_FOLDER}/${safeName(project.name, safeName(project.id, 'Project'))}`;
}

export async function uploadChatFileToOneDrive(
  db: Pool,
  file: { buffer: Buffer; filename: string },
  project: { id: string; name: string },
): Promise<ChatUploadResult> {
  if (!isAllianceConfigured()) throw new OneDriveUnavailableError('OneDrive is not set up.');
  const status = await getAllianceStatus(db);
  if (!status.connected) throw new OneDriveUnavailableError('OneDrive is not connected. Reconnect it from the Library page.');
  if (!status.fileWrite) throw new OneDriveUnavailableError('OneDrive is connected without permission to save files. Reconnect it from the Library page to allow chat uploads.');
  if (file.buffer.length > ONEDRIVE_MAX_FILE_BYTES) throw new ValidationError(`"${file.filename}" is larger than 40 MB.`);

  // Read it before saving, so a file Athena can't read isn't left in OneDrive.
  const { text, warning } = await extractFileText(file.filename, file.buffer);
  if (text.trim() === '') throw new ValidationError(warning ?? `Could not extract any text from "${file.filename}".`);

  const folder = chatUploadFolder(project);
  const root = env.ALLIANCE_ONEDRIVE_ROOT.replace(/^\/+|\/+$/g, '');
  const item = await allianceUploadFile(db, `${root}/${folder}/${safeName(file.filename, 'document')}`, file.buffer);
  const path = `${folder}/${item.name}`;
  const saved = await saveDriveDocument(db, item, path, project.id, text);
  return {
    contentItemId: saved.id, driveItemId: item.id, filename: item.name, path, url: item.webUrl ?? '', text: saved.body,
    ...(warning !== undefined && { warning }),
  };
}
