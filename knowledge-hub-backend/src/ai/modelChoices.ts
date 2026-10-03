/**
 * ai/modelChoices.ts — the models offered for "Ask another model". Each maps
 * to the app's model slot plus, for the reasoning slot, which deployment and
 * API to use (both live on the reasoning endpoint).
 */
import type { AiModel } from '../types/aiContext.js';
import { env } from '../config/env.js';

export interface ModelRoute {
  deployment: string;
  api: 'chat' | 'responses';
}

export interface ModelChoice {
  id: string;
  label: string;
  model: AiModel;
  route?: ModelRoute;
}

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: 'gpt-4o', label: 'GPT-4o', model: 'gpt-4o' },
  { id: 'gpt-5.4', label: 'GPT-5.4', model: 'gpt-5.4', route: { deployment: 'gpt-5.4', api: 'chat' } },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', model: 'gpt-5.4', route: { deployment: 'gpt-6-astra', api: 'responses' } },
];

/** The model for General (and other everyday) chats — the cheaper one. */
export const GENERAL_CHAT_MODEL = 'gpt-4o';

/** Personas that use a specific model (a MODEL_CHOICES id) rather than the defaults. */
export const PERSONA_MODELS: Record<string, string> = {
  podcast_prep: 'gpt-5.4',
};

export function findModelChoice(id: string): ModelChoice | undefined {
  return MODEL_CHOICES.find((c) => c.id === id);
}

/** Personas that run on the reasoning slot, whose deployment (and API) the environment decides. */
const REASONING_SLOT_PERSONAS = new Set(['brainstorming', 'blog_post', 'demo_designer', 'web_designer']);

/**
 * The MODEL_CHOICES id a persona's replies normally come from — so "Ask another model" can say which one
 * would just repeat the reply it is under. Mirrors the routing in routes/ai.ts.
 */
export function defaultModelIdForPersona(persona: string): string {
  if (REASONING_SLOT_PERSONAS.has(persona)) {
    const byEnv = MODEL_CHOICES.find((c) => c.route?.deployment === env.AZURE_OPENAI_DEPLOYMENT_GPT54
      && (c.route.api === 'responses') === (env.AZURE_OPENAI_GPT54_API === 'responses'));
    return byEnv?.id ?? 'gpt-5.4';
  }
  return PERSONA_MODELS[persona] ?? GENERAL_CHAT_MODEL;
}
