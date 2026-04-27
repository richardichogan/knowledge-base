/**
 * emailImportanceFilter.ts
 *
 * Uses Azure OpenAI gpt-4o-mini to batch-score incoming emails by importance.
 * Each email is rated 1–5; only those scoring >= 3 are considered important.
 * We send up to 20 emails per API call to keep costs minimal.
 *
 * If the deployment is missing or the API is unavailable, we fail fast and
 * default all emails to important rather than hanging on retries.
 */

import { env } from '../../config/env.js';
import { HTTP_STATUS } from '../../config/constants.js';

interface EmailMeta {
  subject: string;
  from: string;
  date: string;
}

interface ScoreResult {
  index: number;
  score: number;
}

const BATCH_SIZE = 20;
const IMPORTANCE_THRESHOLD = 2;
const FETCH_TIMEOUT_MS = 8_000; // fail fast — don't hang the sync cycle

/**
 * Calls Azure OpenAI chat completions with the batch of email metadata.
 * Returns an array of scores (1–5), one per email in the same order.
 */
async function scoreBatch(batch: EmailMeta[]): Promise<number[]> {
  const endpoint = env.AZURE_OPENAI_ENDPOINT;
  const apiKey = env.AZURE_OPENAI_API_KEY;
  const deployment = env.AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI;
  const apiVersion = env.AZURE_OPENAI_API_VERSION;

  if (!endpoint || !apiKey || !deployment) {
    // Not configured or known unavailable — default everything to important
    return batch.map(() => IMPORTANCE_THRESHOLD);
  }

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  const emailList = batch
    .map((e, i) => `${i + 1}. From: ${e.from} | Subject: ${e.subject} | Date: ${e.date}`)
    .join('\n');

  const systemPrompt = `You are an email importance classifier.
For each email provided, rate its importance on a scale of 1 to 5:
  5 = Critical / urgent action needed
  4 = Important, should be read soon
  3 = Worth reading, useful information
  2 = Low priority / informational
  1 = Likely spam, newsletter, or unimportant notification

Respond ONLY with a JSON array of objects: [{"index":1,"score":4}, {"index":2,"score":2}, ...]
Index corresponds to the number before each email. Include ALL emails in your response.`;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => { controller.abort(); }, FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Rate these ${batch.length} emails:\n\n${emailList}` },
        ],
        temperature: 0,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const text = await response.text();
    if (response.status === HTTP_STATUS.NOT_FOUND) {
      console.warn('[EmailFilter] Azure OpenAI deployment not found — check AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI in .env');
      return batch.map(() => IMPORTANCE_THRESHOLD);
    }
    throw new Error(`Azure OpenAI scoring failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices[0]?.message?.content ?? '[]';
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) {
    console.warn('[EmailFilter] Could not parse AI response, defaulting all to important');
    return batch.map(() => IMPORTANCE_THRESHOLD);
  }

  const results = JSON.parse(match[0]) as ScoreResult[];
  const scores = new Array<number>(batch.length).fill(IMPORTANCE_THRESHOLD);
  for (const r of results) {
    const idx = r.index - 1;
    if (idx >= 0 && idx < batch.length) {
      scores[idx] = r.score;
    }
  }
  return scores;
}

/**
 * Given an array of email metadata, returns a boolean mask where
 * true = email is important enough to index.
 */
export async function filterImportantEmails(emails: EmailMeta[]): Promise<boolean[]> {
  const mask: boolean[] = emails.map(() => false);

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    try {
      const scores = await scoreBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        mask[i + j] = (scores[j] ?? 0) >= IMPORTANCE_THRESHOLD;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[EmailFilter] Batch scoring failed: ${message} — defaulting to important`);
      for (let j = 0; j < batch.length; j++) {
        mask[i + j] = true;
      }
    }
  }

  return mask;
}
