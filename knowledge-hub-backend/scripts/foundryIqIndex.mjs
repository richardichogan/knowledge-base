/**
 * scripts/foundryIqIndex.mjs
 *
 * POC script: creates the Azure AI Search index schema for Foundry IQ, then
 * backfills it from the existing Postgres `content_items` table, generating
 * embeddings via the already-deployed `text-embedding-3-small` model on the
 * `open-msft-alliance-reporting-res` Azure OpenAI resource.
 *
 * This deliberately uses the *push* model (direct REST document upload) not
 * a pull indexer/data-source, since Azure AI Search does not offer a native
 * indexer connector for Azure Database for PostgreSQL — pushing from the
 * backend, which already has full read access to content_items, is the
 * verified-working approach.
 *
 * Usage:
 *   $env:SEARCH_ENDPOINT = "https://kh-foundry-iq-search.search.windows.net"
 *   $env:SEARCH_ADMIN_KEY = "<admin key>"
 *   $env:AZURE_OPENAI_ENDPOINT = "https://open-msft-alliance-reporting-res.services.ai.azure.com"
 *   $env:AZURE_OPENAI_API_KEY = "<key>"
 *   $env:DATABASE_URL = "<postgres conn string>"
 *   node scripts/foundryIqIndex.mjs --create-index   # one-time schema setup
 *   node scripts/foundryIqIndex.mjs --backfill        # push all content_items rows
 */
import 'dotenv/config';
import { Pool } from 'pg';

const SEARCH_ENDPOINT = process.env.SEARCH_ENDPOINT;
const SEARCH_ADMIN_KEY = process.env.SEARCH_ADMIN_KEY;
const SEARCH_API_VERSION = '2024-07-01'; // stable GA API — index CRUD + vector search
const INDEX_NAME = 'kh-content-items';

const AOAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AOAI_KEY = process.env.AZURE_OPENAI_API_KEY;
const EMBEDDING_DEPLOYMENT = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

function searchUrl(path) {
  return `${SEARCH_ENDPOINT}${path}?api-version=${SEARCH_API_VERSION}`;
}

async function searchRequest(method, path, body) {
  const res = await fetch(searchUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json', 'api-key': SEARCH_ADMIN_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Search API ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function createIndex() {
  const schema = {
    name: INDEX_NAME,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, filterable: true },
      { name: 'source', type: 'Edm.String', filterable: true, facetable: true },
      { name: 'title', type: 'Edm.String', searchable: true },
      { name: 'summary', type: 'Edm.String', searchable: true },
      { name: 'body', type: 'Edm.String', searchable: true },
      { name: 'url', type: 'Edm.String', filterable: false, searchable: false },
      { name: 'projectContext', type: 'Edm.String', filterable: true, facetable: true },
      { name: 'tags', type: 'Collection(Edm.String)', filterable: true, facetable: true },
      { name: 'publishedAt', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
      {
        name: 'contentVector',
        type: 'Collection(Edm.Single)',
        searchable: true,
        dimensions: EMBEDDING_DIMENSIONS,
        vectorSearchProfile: 'kh-vector-profile',
      },
    ],
    vectorSearch: {
      algorithms: [{ name: 'kh-hnsw', kind: 'hnsw' }],
      profiles: [{ name: 'kh-vector-profile', algorithm: 'kh-hnsw' }],
    },
    semantic: {
      configurations: [
        {
          name: 'kh-semantic-config',
          prioritizedFields: {
            titleField: { fieldName: 'title' },
            prioritizedContentFields: [{ fieldName: 'summary' }, { fieldName: 'body' }],
            prioritizedKeywordsFields: [{ fieldName: 'tags' }],
          },
        },
      ],
    },
  };

  await searchRequest('PUT', `/indexes/${INDEX_NAME}`, schema);
  console.log(`Index "${INDEX_NAME}" created/updated.`);
}

async function embed(texts) {
  const res = await fetch(
    `${AOAI_ENDPOINT}/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=2024-06-01`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': AOAI_KEY },
      body: JSON.stringify({ input: texts }),
    },
  );
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

const BATCH_SIZE = 50;
const BODY_CHARS_FOR_EMBEDDING = 2000; // keep embedding input bounded/cheap

async function backfill() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT id, source, title, summary, body, url, project_context, tags, published_at FROM content_items`,
  );
  console.log(`Fetched ${rows.length} content_items rows.`);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const embedInputs = batch.map(
      (r) => `${r.title}\n${r.summary}\n${(r.body || '').substring(0, BODY_CHARS_FOR_EMBEDDING)}`,
    );
    const vectors = await embed(embedInputs);

    const documents = batch.map((r, idx) => ({
      '@search.action': 'mergeOrUpload',
      id: r.id,
      source: r.source,
      title: r.title,
      summary: r.summary,
      body: (r.body || '').substring(0, BODY_CHARS_FOR_EMBEDDING),
      url: r.url ?? '',
      projectContext: r.project_context,
      tags: r.tags ?? [],
      publishedAt: new Date(r.published_at).toISOString(),
      contentVector: vectors[idx],
    }));

    await searchRequest('POST', `/indexes/${INDEX_NAME}/docs/index`, { value: documents });
    console.log(`Pushed ${i + batch.length}/${rows.length}`);
  }

  await pool.end();
  console.log('Backfill complete.');
}

const mode = process.argv[2];
if (mode === '--create-index') await createIndex();
else if (mode === '--backfill') await backfill();
else {
  console.log('Usage: node foundryIqIndex.mjs [--create-index|--backfill]');
  process.exit(1);
}
