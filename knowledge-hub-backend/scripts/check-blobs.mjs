import 'dotenv/config';
import { BlobServiceClient } from '@azure/storage-blob';
import pg from 'pg';

const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
const container = process.env.CMS_BLOB_CONTAINER;
const prefix = process.env.CMS_POSTS_PREFIX;

const client = BlobServiceClient.fromConnectionString(connStr);
const cc = client.getContainerClient(container);

const names = [];
for await (const blob of cc.listBlobsFlat({ prefix })) {
  names.push(blob.name);
}

const postFmt = names.filter(n => n.includes('/post-')).sort();
console.log('post-* blobs:', postFmt.length);
console.log('Latest 5 post-* blobs:', postFmt.slice(-5));

// Check what's in the DB
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(
  "SELECT source_id, title, published_at FROM content_items WHERE source LIKE 'cms%' ORDER BY published_at DESC LIMIT 10"
);
console.log('\nLatest 10 in DB:');
rows.forEach(r => console.log(r.published_at.toISOString().slice(0,10), r.source_id, r.title.slice(0,60)));
await pool.end();

// Download the latest post blob and check its title/date/status
const latestBlob = postFmt[postFmt.length - 1];
const blobClient = cc.getBlobClient(latestBlob);
const text = await (await blobClient.download()).readableStreamBody.then(s => new Promise((res, rej) => {
  const chunks = [];
  s.on('data', c => chunks.push(c));
  s.on('end', () => res(Buffer.concat(chunks).toString()));
  s.on('error', rej);
}));
const post = JSON.parse(text);
console.log('\nLatest blob:', latestBlob);
console.log('Title:', post.title);
console.log('Date:', post.date);
console.log('Status:', post.status);
console.log('ID:', post.id);
