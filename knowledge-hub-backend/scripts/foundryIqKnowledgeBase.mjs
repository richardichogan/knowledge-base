/**
 * scripts/foundryIqKnowledgeBase.mjs
 *
 * POC script: creates a Foundry IQ "knowledge source" (wrapping the
 * kh-content-items index) and a "knowledge base" referencing it, using the
 * 2026-08-01-preview Azure AI Search REST API — these are top-level
 * resources on the Search service itself, no separate Foundry project
 * resource is required to create them.
 *
 * Usage:
 *   $env:SEARCH_ENDPOINT = "https://kh-foundry-iq-search.search.windows.net"
 *   $env:SEARCH_ADMIN_KEY = "<admin key>"
 *   $env:AZURE_OPENAI_ENDPOINT = "https://open-msft-alliance-reporting-res.services.ai.azure.com"
 *   $env:AZURE_OPENAI_API_KEY = "<key>"
 *   node scripts/foundryIqKnowledgeBase.mjs --create
 *   node scripts/foundryIqKnowledgeBase.mjs --query "what does an agentic BPO solution look like for IMAGINE?"
 */
const SEARCH_ENDPOINT = process.env.SEARCH_ENDPOINT;
const SEARCH_ADMIN_KEY = process.env.SEARCH_ADMIN_KEY;
const API_VERSION = '2026-08-01-preview'; // agentic retrieval / knowledge base surface
const INDEX_NAME = 'kh-content-items';
const KNOWLEDGE_SOURCE_NAME = 'kh-content-items-ks';
const KNOWLEDGE_BASE_NAME = 'kh-knowledge-base';

const AOAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AOAI_KEY = process.env.AZURE_OPENAI_API_KEY;

function url(path) {
  return `${SEARCH_ENDPOINT}${path}?api-version=${API_VERSION}`;
}

async function req(method, path, body) {
  const res = await fetch(url(path), {
    method,
    headers: { 'Content-Type': 'application/json', 'api-key': SEARCH_ADMIN_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function createKnowledgeSource() {
  const body = {
    name: KNOWLEDGE_SOURCE_NAME,
    kind: 'searchIndex',
    searchIndexParameters: { searchIndexName: INDEX_NAME },
  };
  await req('PUT', `/knowledgeSources/${KNOWLEDGE_SOURCE_NAME}`, body);
  console.log(`Knowledge source "${KNOWLEDGE_SOURCE_NAME}" created.`);
}

async function createKnowledgeBase() {
  const body = {
    name: KNOWLEDGE_BASE_NAME,
    knowledgeSources: [{ name: KNOWLEDGE_SOURCE_NAME }],
    models: [
      {
        kind: 'azureOpenAI',
        azureOpenAIParameters: {
          resourceUri: AOAI_ENDPOINT,
          apiKey: AOAI_KEY,
          deploymentId: 'gpt-4o',
          modelName: 'gpt-4o',
        },
      },
    ],
    retrievalInstructions:
      'Answer using the connected knowledge base first. Cite sources. If nothing relevant is found, say so plainly rather than guessing.',
  };
  await req('PUT', `/knowledgeBases/${KNOWLEDGE_BASE_NAME}`, body);
  console.log(`Knowledge base "${KNOWLEDGE_BASE_NAME}" created.`);
}

async function query(question) {
  const body = {
    messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
  };
  const result = await req('POST', `/knowledgeBases/${KNOWLEDGE_BASE_NAME}/retrieve`, body);
  console.log(JSON.stringify(result, null, 2));
}

const mode = process.argv[2];
if (mode === '--create') {
  await createKnowledgeSource();
  await createKnowledgeBase();
} else if (mode === '--query') {
  await query(process.argv[3]);
} else {
  console.log('Usage: node foundryIqKnowledgeBase.mjs [--create|--query "question"]');
  process.exit(1);
}
