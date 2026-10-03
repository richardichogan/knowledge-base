/**
 * ai/aiUsage.ts — records every model call (feature, deployment, tokens, time) in ai_usage_log, so
 * "what is costing tokens" can be answered by feature rather than only by deployment.
 * Writes are fire-and-forget: a logging problem must never affect a model call.
 */
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';

export interface TokenUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export interface UsageRecord extends Partial<TokenUsage> {
  feature: string;
  persona?: string | undefined;
  sessionId?: string | undefined;
  /** 'standard' | 'light' | 'reasoning' | 'bulk' | 'embeddings' */
  slot: string;
  deployment: string;
  api: 'chat' | 'responses';
  durationMs: number;
  ok: boolean;
  error?: string | undefined;
}

/** Reads token counts from either API's usage object (chat completions or Responses). */
export function tokenUsageFrom(u: Record<string, unknown> | undefined): TokenUsage {
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {});
  if (u === undefined) return { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 };
  const promptDetails = obj(u['prompt_tokens_details'] ?? u['input_tokens_details']);
  const completionDetails = obj(u['completion_tokens_details'] ?? u['output_tokens_details']);
  return {
    promptTokens: num(u['prompt_tokens'] ?? u['input_tokens']),
    cachedTokens: num(promptDetails['cached_tokens']),
    completionTokens: num(u['completion_tokens'] ?? u['output_tokens']),
    reasoningTokens: num(completionDetails['reasoning_tokens']),
  };
}

export function recordAiUsage(r: UsageRecord): void {
  try {
    void getDb().query(
      `INSERT INTO ai_usage_log
         (environment, feature, persona, session_id, slot, deployment, api,
          prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, duration_ms, ok, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        env.isDevelopment ? 'dev' : 'prod', r.feature, r.persona ?? null, r.sessionId ?? null, r.slot, r.deployment, r.api,
        r.promptTokens ?? 0, r.cachedTokens ?? 0, r.completionTokens ?? 0, r.reasoningTokens ?? 0,
        Math.round(r.durationMs), r.ok, r.error?.slice(0, 300) ?? null,
      ],
    ).catch(() => { /* logging must never affect a model call */ });
  } catch { /* same */ }
}
