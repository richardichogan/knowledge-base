import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { env } from '../config/env.js';
import { getKnowledgeHealth, parseHealthQuery, type HealthQuery } from '../health/knowledgeHealth.js';
import { isKnowledgeOrchestrationEnabled } from './knowledge/budgets.js';
import { ValidationError } from '../types/errors.js';

const SECTIONS = ['usage', 'reliability', 'measurements', 'workflows', 'syncRuns', 'index', 'families', 'retrievalQuality'] as const;
export const HEALTH_TOOL: LlmToolDefinition = {
  type: 'function', function: {
    name: 'read_knowledge_health',
    description: 'Read one current structured instrumentation section for the Health dashboard. Environment means executing backend, not database. Reports measurements and explicit unknowns, not an accuracy score. Read-only; no prompts or message bodies. Shared source inventory is not runtime-specific.',
    parameters: { type: 'object', additionalProperties: false, required: ['section'], properties: {
      section: { type: 'string', enum: [...SECTIONS] }, environment: { type: 'string', enum: ['dev', 'prod'] },
      from: { type: 'string', description: 'UTC YYYY-MM-DD, up to 90 days.' }, to: { type: 'string' },
      feature: { type: 'string' }, persona: { type: 'string' }, deployment: { type: 'string' },
    } },
  },
};

export async function executeHealthTool(db: Pool, args: Record<string, unknown>, restricted: boolean): Promise<unknown> {
  if (restricted) throw new ValidationError('Global health aggregates are unavailable under enforced collection/workstream restrictions.');
  const section = SECTIONS.find(name => name === args.section);
  if (!section) throw new ValidationError('Choose a supported Health section.');
  const query: HealthQuery = {};
  for (const key of ['environment', 'from', 'to', 'feature', 'persona', 'deployment'] as const) {
    const value = args[key];
    if (value !== undefined && typeof value !== 'string') throw new ValidationError(`Supply ${key} as text.`);
    query[key] = value;
  }
  const report = await getKnowledgeHealth(db, parseHealthQuery(query), new Date(), {
    semanticConfigured: Boolean(env.FOUNDRY_IQ_SEARCH_ENDPOINT && env.FOUNDRY_IQ_SEARCH_ADMIN_KEY),
    orchestrationEnabled: isKnowledgeOrchestrationEnabled(),
  });
  return { generatedAt: report.generatedAt, filters: report.filters, section, result: report[section] };
}
