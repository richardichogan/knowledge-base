import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { IMAGINE_DEMO_BRIEF_TEMPLATE, IMAGINE_DEMO_BRIEF_SKILL, IMAGINE_DEMO_BUILD_INSTRUCTION,
  isImagineDemoBriefRequest, validateImagineDemoBrief } from '../src/ai/imagineDemoBriefSkill.js';
import { imagineDemoBriefPrompt, imagineDemoBriefFilename } from '../../knowledge-hub-web/src/notes/imagineDemoBrief.ts';

validateImagineDemoBrief(IMAGINE_DEMO_BRIEF_TEMPLATE);
validateImagineDemoBrief(IMAGINE_DEMO_BRIEF_TEMPLATE.replace(/ \| /g, '|'));
assert.equal((IMAGINE_DEMO_BRIEF_TEMPLATE.match(/^## \d\./gm) ?? []).length, 9);
assert.ok(IMAGINE_DEMO_BRIEF_TEMPLATE.endsWith(IMAGINE_DEMO_BUILD_INSTRUCTION));
for (const section of [1, 5, 9]) {
  assert.throws(() => validateImagineDemoBrief(IMAGINE_DEMO_BRIEF_TEMPLATE.replace(`## ${section}.`, '## Omitted.')), /requires section/);
}
for (const required of ['| Requestor |', '| Retry, duplicate action or restart |']) {
  assert.throws(() => validateImagineDemoBrief(IMAGINE_DEMO_BRIEF_TEMPLATE.replace(required, '| Other |')), /missing required table/);
}
assert.throws(() => validateImagineDemoBrief(IMAGINE_DEMO_BRIEF_TEMPLATE.replace('do not stop at a harness or plan.', 'start building now.')), /unchanged/);
validateImagineDemoBrief('# Ordinary demo spec\n\nNot an IMAGINE brief');
const source = '# Example use case\n\n' + 'Full source '.repeat(3_000) + '\n\nFinal unsaved business decision.';
const prompt = imagineDemoBriefPrompt('Example', source);
assert.ok(prompt.includes(source));
assert.ok(prompt.includes('Final unsaved business decision.'));
assert.ok(prompt.includes('Do not edit the source note'));
assert.ok(isImagineDemoBriefRequest('demo_designer', prompt));
assert.ok(!isImagineDemoBriefRequest('general', prompt));
assert.ok(!isImagineDemoBriefRequest('demo_designer', 'Make a demo script'));
assert.ok(!isImagineDemoBriefRequest('demo_designer', 'Summarize this\n--- BEGIN USE CASE SOURCE ---\nIMAGINE demo brief'));
assert.equal(imagineDemoBriefFilename('# IMAGINE demo brief: Claims & Recovery / MVP'), 'claims-recovery-mvp.md');
assert.equal(imagineDemoBriefFilename('# IMAGINE demo brief: ../../'), 'imagine-demo-brief.md');
assert.equal(imagineDemoBriefFilename('# Ordinary spec'), null);
for (const safeguard of ['missing configuration', 'Unresolved', 'save_output', 'Do not overwrite the source note', 'browser acceptance']) {
  assert.ok(IMAGINE_DEMO_BRIEF_SKILL.toLowerCase().includes(safeguard.toLowerCase()), safeguard);
}
console.log('IMAGINE brief: nine sections, required tables, exact build instruction, full source, safe export names and routing passed.');

const db = new PGlite();
try {
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = 'postgresql://isolated.invalid/offline';
  const { saveOutputVersion, getOutput, listOutputs } = await import('../src/ai/chatOutputs.js');
  await db.exec('CREATE TABLE ai_chat_sessions (id UUID PRIMARY KEY);');
  await db.exec(await readFile(new URL('../src/db/migrations/043_chat_outputs_decisions.sql', import.meta.url), 'utf8'));
  // Match the pg client surface used by the service; all writes stay in isolated in-memory PostgreSQL.
  const client = { query: (sql: string, values?: unknown[]) => db.query(sql, values), release() {} };
  const pool = { ...client, connect: async () => client } as unknown as Pool;
  const session = '11111111-1111-4111-8111-111111111111';
  const saved = await saveOutputVersion(pool, session, {
    title: 'IMAGINE demo brief', kind: 'spec', format: 'markdown', content: IMAGINE_DEMO_BRIEF_TEMPLATE, author: 'athena',
  });
  assert.equal(saved.version, 1);
  assert.equal((await getOutput(pool, saved.id))?.versions[0]?.content, IMAGINE_DEMO_BRIEF_TEMPLATE);
  const revised = IMAGINE_DEMO_BRIEF_TEMPLATE.replace('<name>', 'Claims Recovery');
  const revision = await saveOutputVersion(pool, session, { outputId: saved.id, content: revised, author: 'athena' });
  assert.equal(revision.version, 2);
  assert.equal((await listOutputs(pool, session)).length, 1);
  assert.equal((await getOutput(pool, saved.id))?.versions[1]?.content, revised);
  await assert.rejects(saveOutputVersion(pool, session, {
    outputId: saved.id, content: revised.replace('## 9.', '## Missing.'), author: 'athena',
  }), /requires section 9/);
  assert.equal((await getOutput(pool, saved.id))?.versions.length, 2, 'Invalid generated revision cannot replace a valid brief');
  console.log('IMAGINE Output persistence: exact Markdown, same-output revisions and rejection of incomplete generated briefs passed.');
} finally { await db.close(); }
