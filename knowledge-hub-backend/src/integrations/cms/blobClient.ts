import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { env } from '../../config/env.js';
import { BlobStorageError } from '../../types/errors.js';

let blobServiceClient: BlobServiceClient | undefined;

/**
 * Returns a singleton BlobServiceClient.
 *
 * In production (Azure App Service): uses DefaultAzureCredential → Managed Identity.
 * In local development: uses the connection string from env if provided,
 * otherwise falls back to DefaultAzureCredential (requires `az login`).
 *
 * No credentials are ever stored in code — spec requirement.
 */
export function getBlobClient(): BlobServiceClient {
  if (blobServiceClient) {
    return blobServiceClient;
  }

  if (env.AZURE_STORAGE_CONNECTION_STRING) {
    // Local dev only — connection string path
    blobServiceClient = BlobServiceClient.fromConnectionString(
      env.AZURE_STORAGE_CONNECTION_STRING,
    );
  } else {
    // Production path — Managed Identity via DefaultAzureCredential
    const credential = new DefaultAzureCredential();
    blobServiceClient = new BlobServiceClient(env.AZURE_BLOB_ACCOUNT_URL ?? '', credential);
  }

  return blobServiceClient;
}

/**
 * Downloads a blob as a UTF-8 string.
 * @throws BlobStorageError if the blob does not exist or cannot be read.
 */
export async function downloadBlobAsText(
  containerName: string,
  blobPath: string,
): Promise<string> {
  const client = getBlobClient();
  const containerClient = client.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobPath);

  try {
    const response = await blobClient.download();
    const chunks: Buffer[] = [];

    if (!response.readableStreamBody) {
      throw new BlobStorageError('download', `No stream body for blob: ${blobPath}`);
    }

    for await (const chunk of response.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString('utf-8');
  } catch (err) {
    if (err instanceof BlobStorageError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new BlobStorageError('download', `${blobPath}: ${message}`);
  }
}

/**
 * Uploads text content to a blob path.
 * @throws BlobStorageError if the upload fails.
 */
export async function uploadBlobAsText(
  containerName: string,
  blobPath: string,
  content: string,
  contentType = 'application/json',
): Promise<void> {
  const client = getBlobClient();
  const containerClient = client.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

  try {
    await blockBlobClient.upload(content, Buffer.byteLength(content, 'utf-8'), {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BlobStorageError('upload', `${blobPath}: ${message}`);
  }
}

/**
 * Returns the last-modified date of a blob — used for change detection.
 * Returns null if the blob does not exist.
 */
export async function getBlobLastModified(
  containerName: string,
  blobPath: string,
): Promise<Date | null> {
  const client = getBlobClient();
  const containerClient = client.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobPath);

  try {
    const props = await blobClient.getProperties();
    return props.lastModified ?? null;
  } catch {
    return null;
  }
}

/**
 * Lists all blob names matching a prefix.
 */
export async function listBlobNames(
  containerName: string,
  prefix: string,
): Promise<string[]> {
  const client = getBlobClient();
  const containerClient = client.getContainerClient(containerName);
  const names: string[] = [];

  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    names.push(blob.name);
  }

  return names;
}

// Suppress unused import warning — StorageSharedKeyCredential exported for
// future use in local Azurite emulator setup.
export { StorageSharedKeyCredential };
