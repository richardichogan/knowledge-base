import { readFileSync, writeFileSync } from 'node:fs';
import { EVAL_PACK } from './fixtures/knowledge/evalPack.js';

/**
 * Supplementary model-judged scoring for a live evaluation trace (spec 12.2: "A model judge may assist but cannot be
 * the sole release authority"). The verbatim substring score in knowledge-eval.ts stays the gate; this adds a judged
 * view of required factual elements and abstention/qualification. Human review is still required.
 * Usage: KNOWLEDGE_EVAL_LIVE=approved KNOWLEDGE_EVAL_DATABASE_URL=<loopback> AZURE_OPENAI_* node --import tsx/esm
 *   scripts/knowledge-eval-judge.ts <trace.jsonl> <out.json>
 */
if (process.env.KNOWLEDGE_EVAL_LIVE !== 'approved') throw new Error('KNOWLEDGE_EVAL_LIVE=approved required');
const dbUrl = process.env.KNOWLEDGE_EVAL_DATABASE_URL;
if (!dbUrl || !['127.0.0.1', 'localhost'].includes(new URL(dbUrl).hostname)) throw new Error('loopback KNOWLEDGE_EVAL_DATABASE_URL required');
process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'development';
const [tracePath, outPath] = process.argv.slice(2);
if (!tracePath || !outPath) throw new Error('usage: <trace.jsonl> <out.json>');

const { getFoundryClient } = await import('../src/ai/foundryClient.js');
const client = getFoundryClient('knowledge-eval-judge');
const trace = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; answer: string });
const byId = new Map(EVAL_PACK.map((q) => [q.id, q] as const));

interface Verdict { facts: boolean[]; qualified: boolean | null; forbidden: boolean[] }
async function judge(answer: string, id: string): Promise<Verdict> {
  const q = byId.get(id)!;
  const prompt = `You are grading an assistant answer against a fixed rubric. Judge meaning, not wording. Respond with JSON only.
Question: ${q.question}
Answer: """${answer}"""
Expected facts (each must be clearly conveyed by the answer, in substance): ${JSON.stringify(q.expectedFacts)}
Forbidden claims (true if the answer asserts or endorses the claim as fact): ${JSON.stringify(q.forbiddenClaims)}
This question is ${q.answerable ? 'answerable' : 'deliberately unanswerable or unavailable'}. Acceptable ways to abstain or qualify: ${JSON.stringify(q.acceptedUncertainty)}
Return {"facts":[bool per expected fact],"forbidden":[bool per forbidden claim],"qualified":${q.answerable ? 'null' : 'true if the answer clearly says it cannot establish/find the answer or qualifies it in substance, else false'}}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await client.chat('standard', [{ role: 'user', content: prompt }], 800);
      const m = /\{[\s\S]*\}/.exec(text);
      if (m) return JSON.parse(m[0]) as Verdict;
    } catch { /* retry */ }
  }
  throw new Error(`judge failed for ${id}`);
}

const out: Array<{ run: number; id: string; verdict: Verdict }> = [];
for (let i = 0; i < trace.length; i++) {
  const t = trace[i]!;
  out.push({ run: Math.floor(i / EVAL_PACK.length) + 1, id: t.id, verdict: await judge(t.answer, t.id) });
}
writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`judged ${out.length} answers`);
process.exit(0);
