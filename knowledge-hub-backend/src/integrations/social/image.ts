import { ValidationError } from '../../types/errors.js';

export interface SocialImage { bytes: Uint8Array; alt: string; mimeType: 'image/png' }
const PNG_HEADER_BYTES = 24;
const MAX_IMAGE_BYTES = 1_000_000;
const PNG_SIGNATURE_BYTES = 8;
export function validateSocialImage(image: SocialImage): void {
  if (image.bytes.byteLength < PNG_HEADER_BYTES || image.bytes.byteLength > MAX_IMAGE_BYTES
    || Buffer.from(image.bytes.subarray(0, PNG_SIGNATURE_BYTES)).toString('hex') !== '89504e470d0a1a0a'
    || !image.alt.trim()) throw new ValidationError('The approved social image must be a PNG below 1 MB with descriptive alternative text.');
}
