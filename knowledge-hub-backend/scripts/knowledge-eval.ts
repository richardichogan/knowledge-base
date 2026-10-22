import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVAL_PACK, evaluateRecall, validateEvalPack, type EvalQuestion } from './fixtures/knowledge/evalPack.js';
import { PINNED_NOW_ISO, seededRandom } from './fixtures/knowledge/constants.js';
import { CORPUS } from './fixtures/knowledge/corpus.js';

/**
 * Knowledge evaluation harness (spec 12.2).
 *  - Default: deterministic mock model/retriever. Verifies orchestration and scoring only, never reasoning quality.
 *  - Live: refused unless KNOWLEDGE_EVAL_LIVE=approved. Needs KNOWLEDGE_EVAL_ADAPTER (module exporting `adapter`).
 *    Each run records deployment id, parameters, time and per-question evidence to KNOWLEDGE_EVAL_OUT.
 * Exit codes: 0 pass, 1 threshold/safety failure, 2 refused or unverified.
 */

export interface EvalAnswer {
  retrieved: readonly string[];
  answer: string;
  citations: readonly string[];
  usage?: { inputTokens: number; outputTokens: number; calls: number; semanticQueries?: number; embeddings?: number };
}

export interface EvalAdapter {
  describe(): { deployment: string; params: Record<string, unknown> };
  run(question: EvalQuestion): Promise<EvalAnswer>;
}

/** Deterministic mock: gold records ranked among seeded decoys; the answer restates expected facts. */
export function createMockAdapter(seed = 7): EvalAdapter {
  const decoys = CORPUS.map((r) => r.alias);
  return {
    describe: () => ({ deployment: 'mock-model', params: { seed, temperature: 0 } }),
    async run(item) {
      const rnd = seededRandom(seed + item.id.length * 131 + item.id.charCodeAt(item.id.length - 1));
      const gold = [...item.requiredRecords];
      const noise = decoys.filter((a) => !gold.includes(a)).sort(() => rnd() - 0.5).slice(0, 6);
      const retrieved = [...noise.slice(0, 3), ...gold, ...noise.slice(3)];
      const lead = item.answerable ? '' : `${item.acceptedUncertainty[0] ?? 'cannot establish'}. `;
      return { retrieved, answer: `${lead}${item.expectedFacts.join('. ')}.`, citations: [...gold] };
    },
  };
}

export interface QuestionResult {
  id: string;
  category: string;
  critical: boolean;
  retrieved: readonly string[];
  factsFound: number;
  factsTotal: number;
  forbiddenHits: string[];
  abstainedCorrectly: boolean | null;
  citationsValid: boolean;
  usage?: EvalAnswer['usage'];
}

export interface RunReport {
  mode: 'mock' | 'live';
  startedAt: string;
  deployment: string;
  params: Record<string, unknown>;
  pinnedClock: string;
  packSize: number;
  recall: { macro: number; perFamily: Record<string, number>; familiesBelowFloor: string[] };
  factCoverage: number;
  criticalFailures: string[];
  abstentionCorrect: number;
  citationValidity: number;
  passed: boolean;
  failures: string[];
  results: QuestionResult[];
}

const has = (text: string, phrase: string) => text.toLowerCase().includes(phrase.toLowerCase());

export async function runEvaluation(adapter: EvalAdapter, mode: 'mock' | 'live', pack: readonly EvalQuestion[] = EVAL_PACK): Promise<RunReport> {
  const problems = validateEvalPack(pack);
  if (problems.length) throw new Error(`Evaluation pack invalid: ${problems.join('; ')}`);
  const answers = new Map<string, EvalAnswer>();
  const results: QuestionResult[] = [];
  const startedAt = new Date().toISOString();
  for (const item of pack) {
    const a = await adapter.run(item);
    answers.set(item.id, a);
    const forbiddenHits = item.forbiddenClaims.filter((c) => has(a.answer, c));
    const factsFound = item.expectedFacts.filter((f) => has(a.answer, f)).length;
    const retrievedSet = new Set(a.retrieved);
    results.push({
      id: item.id, category: item.category, critical: item.critical, retrieved: a.retrieved,
      factsFound, factsTotal: item.expectedFacts.length, forbiddenHits,
      abstainedCorrectly: item.answerable ? null : item.acceptedUncertainty.some((u) => has(a.answer, u)),
      citationsValid: a.citations.every((c) => retrievedSet.has(c)),
      ...(a.usage ? { usage: a.usage } : {}),
    });
  }
  const recall = evaluateRecall(pack, (item) => answers.get(item.id)?.retrieved ?? []);
  const factTotal = results.reduce((s, r) => s + r.factsTotal, 0);
  const factCoverage = factTotal ? results.reduce((s, r) => s + r.factsFound, 0) / factTotal : 0;
  const abst = results.filter((r) => r.abstainedCorrectly !== null);
  const abstentionCorrect = abst.length ? abst.filter((r) => r.abstainedCorrectly).length / abst.length : 1;
  const citationValidity = results.filter((r) => r.citationsValid).length / results.length;
  const criticalFailures = results
    .filter((r) => r.forbiddenHits.length > 0 || (r.critical && r.factsFound < r.factsTotal))
    .map((r) => r.id);
  const failures: string[] = [];
  if (recall.macro < 0.9) failures.push(`recall@10 macro ${recall.macro.toFixed(3)} < 0.90`);
  if (recall.familiesBelowFloor.length) failures.push(`families below 0.80 recall: ${recall.familiesBelowFloor.join(', ')}`);
  if (criticalFailures.length) failures.push(`critical facts/forbidden claims failed: ${criticalFailures.join(', ')}`);
  if (factCoverage < 0.9) failures.push(`fact coverage ${factCoverage.toFixed(3)} < 0.90`);
  if (abstentionCorrect < 1) failures.push('abstention/qualification below 100%');
  if (citationValidity < 1) failures.push('citation validity below 100%');
  const { deployment, params } = adapter.describe();
  return {
    mode, startedAt, deployment, params, pinnedClock: PINNED_NOW_ISO, packSize: pack.length,
    recall: { macro: recall.macro, perFamily: recall.perFamily, familiesBelowFloor: recall.familiesBelowFloor },
    factCoverage, criticalFailures, abstentionCorrect, citationValidity, passed: failures.length === 0, failures, results,
  };
}

/** Returns a refusal message unless live evaluation has been explicitly approved. */
export function liveRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.KNOWLEDGE_EVAL_LIVE === 'approved') return null;
  return 'Live evaluation refused: set KNOWLEDGE_EVAL_LIVE=approved after the owner approves AI usage. Result: unverified.';
}

async function main(): Promise<number> {
  const live = process.argv.includes('--live');
  if (!live) {
    const report = await runEvaluation(createMockAdapter(), 'mock');
    console.log(JSON.stringify({ mode: report.mode, passed: report.passed, packSize: report.packSize, recall: report.recall.macro, factCoverage: report.factCoverage, failures: report.failures, note: 'mock run verifies orchestration only, not model reasoning' }, null, 2));
    return report.passed ? 0 : 1;
  }
  const refusal = liveRefusal();
  if (refusal) { console.error(refusal); return 2; }
  const adapterPath = process.env.KNOWLEDGE_EVAL_ADAPTER;
  if (!adapterPath) { console.error('Live evaluation unverified: KNOWLEDGE_EVAL_ADAPTER (module exporting `adapter`) is not set.'); return 2; }
  const mod = (await import(pathToFileURL(resolve(adapterPath)).href)) as { adapter?: EvalAdapter };
  if (!mod.adapter) { console.error('Adapter module must export `adapter`.'); return 2; }
  const outDir = resolve(process.env.KNOWLEDGE_EVAL_OUT ?? 'knowledge-eval-runs');
  mkdirSync(outDir, { recursive: true });
  const runs = Number(process.env.KNOWLEDGE_EVAL_RUNS ?? 3);
  let ok = true;
  for (let i = 1; i <= runs; i++) {
    const report = await runEvaluation(mod.adapter, 'live');
    const file = resolve(outDir, `knowledge-eval-${report.startedAt.replace(/[:.]/g, '-')}-run${i}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`run ${i}/${runs}: ${report.passed ? 'PASS' : 'FAIL'} deployment=${report.deployment} evidence=${file}`);
    ok &&= report.passed;
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((c) => { process.exit(c); }, (e) => { console.error(e); process.exit(1); });
}
