/**
 * ai/modelChoices.ts — the models offered for "Ask another model". Each maps
 * to one of the app's model slots plus, where needed, which deployment and
 * API to use (the reasoning slot's deployments live on the reasoning endpoint).
 *
 * "Which one wrote this reply" is decided by the deployment actually behind it,
 * not by the name of the slot, so the menu can never offer the model that wrote
 * the reply as if it were a different one.
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
  // The light slot: a fast, cheaper model for a quick second view.
  { id: 'gpt-4o', label: 'GPT-4o (fast)', model: 'light' },
  { id: 'gpt-5.4', label: 'GPT-5.4', model: 'reasoning', route: { deployment: 'gpt-5.4', api: 'chat' } },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', model: 'reasoning', route: { deployment: 'gpt-6-astra', api: 'responses' } },
];

/** Personas that use a specific model (a MODEL_CHOICES id) rather than the defaults. */
export const PERSONA_MODELS: Record<string, string> = {
  podcast_prep: 'gpt-5.4',
};

export function findModelChoice(id: string): ModelChoice | undefined {
  return MODEL_CHOICES.find((c) => c.id === id);
}

/** Personas that run on the reasoning slot, whose deployment (and API) the environment decides. */
const REASONING_SLOT_PERSONAS = new Set(['brainstorming', 'blog_post', 'demo_designer', 'web_designer']);

/** The deployment a model slot points at in this environment. */
function slotDeployment(slot: AiModel): string {
  if (slot === 'standard') return env.AZURE_OPENAI_DEPLOYMENT_GPT4O;
  if (slot === 'light') return env.AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI;
  return env.AZURE_OPENAI_DEPLOYMENT_GPT54;
}

function choiceRoute(c: ModelChoice): ModelRoute {
  return c.route ?? { deployment: slotDeployment(c.model), api: 'chat' };
}

/**
 * The MODEL_CHOICES id a persona's replies normally come from — so "Ask another model" can say which one
 * would just repeat the reply it is under. Mirrors the routing in routes/ai.ts and compares real deployments.
 */
export function defaultModelIdForPersona(persona: string): string | undefined {
  const target: ModelRoute = REASONING_SLOT_PERSONAS.has(persona)
    ? { deployment: env.AZURE_OPENAI_DEPLOYMENT_GPT54, api: env.AZURE_OPENAI_GPT54_API === 'responses' ? 'responses' : 'chat' }
    : choiceRoute(findModelChoice(PERSONA_MODELS[persona] ?? '') ?? { id: '', label: '', model: 'standard' });
  return MODEL_CHOICES.find((c) => {
    const r = choiceRoute(c);
    return r.deployment === target.deployment && r.api === target.api;
  })?.id;
}
