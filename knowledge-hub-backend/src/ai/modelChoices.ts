/**
 * ai/modelChoices.ts — the models offered for "Ask another model". Each maps
 * to the app's model slot plus, for the reasoning slot, which deployment and
 * API to use (both live on the reasoning endpoint).
 */
import type { AiModel } from '../types/aiContext.js';

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

export function findModelChoice(id: string): ModelChoice | undefined {
  return MODEL_CHOICES.find((c) => c.id === id);
}
