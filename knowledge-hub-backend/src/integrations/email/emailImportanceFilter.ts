/**
 * emailImportanceFilter.ts
 *
 * Uses the configured light deployment to batch-score incoming emails by importance.
 * Each email is rated 1–5; those scoring >= 2 are considered important.
 * We send up to 20 emails per API call to keep costs minimal.
 *
 * If the deployment is missing or the API is unavailable, we fail fast and
 * default all emails to important rather than hanging on retries.
 */

import { env } from '../../config/env.js';
import { recordAiUsage, tokenUsageFrom, type TokenUsage } from '../../ai/aiUsage.js';
import { HTTP_STATUS } from '../../config/constants.js';

interface EmailMeta {
  subject: string;
  from: string;
  date: string;
}

const BATCH_SIZE = 20;
const IMPORTANCE_THRESHOLD = 2;
const MAX_IMPORTANCE_SCORE = 5;
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

  const t0 = Date.now();
  let usage: TokenUsage | undefined;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Rate these ${batch.length} emails:\n\n${emailList}` },
        ],
        temperature: 0,
        max_completion_tokens: 500,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text();
      if (response.status === HTTP_STATUS.NOT_FOUND) {
        throw new Error('Azure OpenAI deployment not found — check AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI');
      }
      throw new Error(`Azure OpenAI scoring failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as {
      choices: Array<{ message: { content: string }; finish_reason?: string }>;
      usage?: Record<string, unknown>;
    };
    usage = tokenUsageFrom(data.usage);
    if (data.choices[0]?.finish_reason !== 'stop') throw new Error('Email classification was incomplete or refused');
    const content = data.choices[0]?.message?.content ?? '';
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Email classification did not return scores');
    const results: unknown = JSON.parse(match[0]);
    if (!Array.isArray(results)) throw new Error('Email classification scores were invalid');
    const scores = new Array<number>(batch.length).fill(0);
    for (const r of results as unknown[]) {
      if (!r || typeof r !== 'object' || !('index' in r) || !('score' in r)
        || typeof r.index !== 'number' || !Number.isInteger(r.index) || r.index < 1 || r.index > batch.length
        || typeof r.score !== 'number' || !Number.isInteger(r.score) || r.score < 1 || r.score > MAX_IMPORTANCE_SCORE
        || scores[r.index - 1] !== 0) throw new Error('Email classification contained an invalid or repeated score');
      scores[r.index - 1] = r.score;
    }
    if (scores.some(score => score === 0)) throw new Error('Email classification omitted emails');
    recordAiUsage({ feature: 'email-importance', slot: 'light', deployment, api: 'chat', durationMs: Date.now() - t0, ok: true, ...usage });
    return scores;
  } catch (error) {
    recordAiUsage({ feature: 'email-importance', slot: 'light', deployment, api: 'chat',
      durationMs: Date.now() - t0, ok: false, error: error instanceof Error ? error.message : String(error), ...usage });
    throw error;
  }
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
