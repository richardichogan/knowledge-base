import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';

const GPT54_CONTEXT_TOKENS = 1_050_000;
const CONSERVATIVE_CONTEXT_TOKENS = 128_000;
export const REVIEW_CONTEXT_RESERVE = 8_192;
export const READING_BATCH_TOKENS = 64_000;
let encoder: Tiktoken | undefined;

export function textTokens(text: string): number {
  encoder ??= new Tiktoken(o200k);
  // Source documents may contain token-like strings; they are data, not control tokens.
  return encoder.encode(text, [], []).length;
}

export function reviewContextTokens(deployment: string): number {
  // Deployment aliases/unknown models get the smaller verified GPT-4o window.
  return /^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(deployment)
    ? GPT54_CONTEXT_TOKENS : CONSERVATIVE_CONTEXT_TOKENS;
}

export function remainingReviewTokens(contextTokens: number, messages: unknown, tools: unknown, outputTokens: number): number {
  return Math.max(0, contextTokens - outputTokens - REVIEW_CONTEXT_RESERVE
    - textTokens(JSON.stringify({ messages, tools })));
}
