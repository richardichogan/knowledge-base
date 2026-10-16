import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { env } from '../config/env.js';
import { BlobStorageError } from '../types/errors.js';

export function createAthenaStorage(accountName: string | undefined, accountKey: string | undefined): {
  service: BlobServiceClient;
  credential: StorageSharedKeyCredential;
} {
  if (!accountName?.trim() || !accountKey?.trim()) {
    throw new BlobStorageError('config', 'ATHENA_STORAGE_ACCOUNT_NAME and ATHENA_STORAGE_ACCOUNT_KEY must be set; CMS credentials are not used for Athena files');
  }
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  return { service: new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential), credential };
}

export function getAthenaStorage(): ReturnType<typeof createAthenaStorage> {
  return createAthenaStorage(env.ATHENA_STORAGE_ACCOUNT_NAME, env.ATHENA_STORAGE_ACCOUNT_KEY);
}
