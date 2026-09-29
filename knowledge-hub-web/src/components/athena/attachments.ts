/**
 * components/athena/attachments.ts — helpers for files attached to an Athena
 * message (images vs documents, names for pasted clipboard images).
 */

export const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isChatImage(file: File): boolean {
  return CHAT_IMAGE_TYPES.has(file.type.toLowerCase());
}

export function clipboardImageName(mimeType: string): string {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1] ?? 'png';
  return `pasted-image-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
}
