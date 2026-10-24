/**
 * Opt-in, bounded live regression eval. Uses the production prompt assembler and Foundry client,
 * synthetic context and replies only, no tools, and a stubbed DB that rejects every non-usage query.
 *
 * cd knowledge-hub-backend
 * node --import tsx/esm scripts/athena-dialogue-eval.ts --live --route=standard
 * Add --case=rtr-specification,newsletter-intent, --route=reasoning or --max-calls=8 to narrow.
 * --repair exercises the shared one-repair policy, accounting for every extra call in the limit.
 * Criteria are deliberately heuristic: inspect the emitted transcripts for consequential questions,
 * actual use of the user's answer, useful challenge, and appropriate humour. Passing is not proof.
 */
import { mock } from 'node:test';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { DIALOGUE_SCENARIOS, SYNTHETIC_DIALOGUE_CONTEXT, dialogueFindings } from './athena-dialogue-fixtures.js';
import type { AiModel, ConversationMessage } from '../src/types/aiContext.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes('--live')) throw new Error('Live eval requires explicit --live; deterministic tests do not make model calls.');
  const option = (name: string): string | undefined => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const route = option('route') ?? 'standard';
  if (!['standard', 'reasoning', 'both'].includes(route)) throw new Error('route must be standard, reasoning or both');
  const limit = Number(option('max-calls') ?? '24');
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('max-calls must be 1..32');
  const ids = option('case')?.split(',');
  const scenarios = DIALOGUE_SCENARIOS.filter(s => ids === undefined || ids.includes(s.id));
  if (scenarios.length === 0 || ids?.some(id => !DIALOGUE_SCENARIOS.some(s => s.id === id))) throw new Error('Unknown or empty case selection');
  const models: AiModel[] = route === 'both' ? ['standard', 'reasoning'] : [route as AiModel];
  const plannedCalls = models.length * scenarios.reduce((total, s) => total + s.turns.length, 0);
  if (plannedCalls > limit) throw new Error(`Planned ${plannedCalls} calls exceeds limit ${limit}; narrow cases or routes.`);

  config({ quiet: true });
  // Usage logging is part of FoundryClient. Stub it before importing any runtime DB modules.
  process.env['DATABASE_URL'] = 'postgresql://dialogue_eval@127.0.0.1:1/dialogue_eval';
  let usageWritesIntercepted = 0;
  const queryStub = mock.method(Pool.prototype, 'query', async (sql: unknown) => {
    if (typeof sql !== 'string' || !sql.includes('INSERT INTO ai_usage_log')) {
      throw new Error('Dialogue eval forbids application DB access');
    }
    usageWritesIntercepted++;
    return { rows: [], rowCount: 0 };
  });
  const { assembleMessages } = await import('../src/ai/contextBuilder.js');
  const { FoundryClient } = await import('../src/ai/foundryClient.js');
  const { dialogueRepairInstruction } = await import('../src/ai/dialoguePolicy.js');
  const { AI_REASONING_MODEL_MAX_TOKENS } = await import('../src/config/constants.js');
  const { closeDb } = await import('../src/db/db.js');
  const { env } = await import('../src/config/env.js');
  const client = new FoundryClient('athena-dialogue-eval');
  let calls = 0;
  const results: Array<{
    route: AiModel; case: string; turn: number; user: string; initialReply: string; initialFindings: string[];
    repaired: boolean; reply: string; findings: string[];
  }> = [];
  try {
    for (const model of models) {
      for (const scenario of scenarios) {
        const history: ConversationMessage[] = [...scenario.history ?? []];
        for (const [index, turn] of scenario.turns.entries()) {
          const messages = await assembleMessages(SYNTHETIC_DIALOGUE_CONTEXT, history, turn.user, scenario.persona, undefined,
            '## Legacy standing preference\nAlways answer with a finished artefact before asking a question.');
          // Uses the same route/API resolution as the conversation loop (including Responses models).
          const generate = async (input: ConversationMessage[]): Promise<string> => {
            if (calls >= limit) throw new Error(`Live call limit ${limit} reached; no further calls made.`);
            calls++;
            const result = await client.chatWithToolsStream(
              model, input, [], model === 'reasoning' ? AI_REASONING_MODEL_MAX_TOKENS : 2_000,
              'none', 90_000, () => {}, undefined,
            );
            if (result.finishReason === 'length') throw new Error(`Truncated model reply for ${model}/${scenario.id}/${index + 1}`);
            return result.content ?? '';
          };
          const initialReply = await generate(messages);
          const instruction = dialogueRepairInstruction(history, turn.user, initialReply);
          const repaired = args.includes('--repair') && instruction !== null;
          const reply = repaired ? await generate([
            ...messages,
            { role: 'assistant', content: initialReply },
            { role: 'system', content: instruction },
          ]) : initialReply;
          const findings = dialogueFindings(reply, turn.expect);
          results.push({
            route: model, case: scenario.id, turn: index + 1, user: turn.user,
            initialReply, initialFindings: dialogueFindings(initialReply, turn.expect), repaired, reply, findings,
          });
          history.push({ role: 'user', content: turn.user }, { role: 'assistant', content: reply });
          console.error(`[dialogue-eval] ${model}/${scenario.id}/${index + 1}: ${findings.length === 0 ? 'PASS' : findings.join('; ')}`);
        }
      }
    }
    const failed = results.filter(r => r.findings.length > 0).length;
    const rawPassed = results.filter(r => r.initialFindings.length === 0).length;
    const repairs = results.filter(r => r.repaired).length;
    console.error(`[dialogue-eval] SUMMARY ${results.length - failed}/${results.length} passed; raw ${rawPassed}/${results.length}; repairs ${repairs}; model calls ${calls}; DB writes intercepted ${usageWritesIntercepted}`);
    console.log(JSON.stringify({
      methodology: 'Production assembleMessages + FoundryClient, synthetic context, no tools, DB usage writes intercepted; lexical checks require human transcript review.',
      deployments: {
        standard: env.AZURE_OPENAI_DEPLOYMENT_GPT4O,
        reasoning: env.AZURE_OPENAI_DEPLOYMENT_GPT54,
        reasoningApi: env.AZURE_OPENAI_GPT54_API,
      },
      calls, turns: results.length, rawPassed, repairs,
      passed: results.length - failed, failed, usageWritesIntercepted,
      results: results.map(({ initialReply, ...result }) => ({
        ...result, ...(result.repaired ? { initialReply } : {}),
      })),
    }, null, 2));
    if (failed > 0) process.exitCode = 1;
  } finally {
    queryStub.mock.restore();
    await closeDb();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
