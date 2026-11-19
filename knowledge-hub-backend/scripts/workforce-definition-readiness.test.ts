import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesignSource } from '../src/designs/designArtifacts.js';
import { mechanicalReadiness, parseReadinessReview, readinessFingerprint, readinessVersions } from '../src/designs/designReadiness.js';
import { currentSpecApproval } from '../src/designs/imagineHarness.js';
import { WORKFORCE_DEFINITION_AREAS, WORKFORCE_DEFINITION_MARKER } from '../src/designs/workforceDefinitionScope.js';

const scope = 'workforce-definition';
const checkedAt = '2026-11-18T00:00:00Z';
const quote = 'The analyst approves the recommendation; the orchestrator cannot approve it.';
const section = (area: string) => `## ${area}\n\n${quote}`;
const source = (markdown: string): DesignSource => ({ id: 'spec', role: 'spec', revision: 3, title: 'Workforce Spec', markdown, blocks: [] });

test('workforce definition expects the marker and all nine areas, not full-demo sections', () => {
  const markdown = [WORKFORCE_DEFINITION_MARKER, ...WORKFORCE_DEFINITION_AREAS.map(section)].join('\n\n');
  assert.deepEqual(mechanicalReadiness(source(markdown), checkedAt, scope).findings, []);
  assert.ok(mechanicalReadiness(source(markdown), checkedAt).findings.some(finding => finding.rule === 'section:10'));
  const incomplete = markdown.replace(section('Hierarchy'), `~~~md\n${section('Hierarchy')}\n~~~`)
    .replace(section('Ownership'), '## Ownership\n\nTBD') + `\n\n${section('Evaluation definitions')}`;
  assert.deepEqual(mechanicalReadiness(source(incomplete), checkedAt, scope).findings.map(finding => finding.target),
    ['Hierarchy', 'Ownership', 'Evaluation definitions']);
});

test('workforce definition semantic review preserves exact evidence and permits real authority blockers only', () => {
  const spec = source(`${WORKFORCE_DEFINITION_MARKER}\n${quote}`);
  const evidence = [{ passageId: 'p2' }];
  const coverage = WORKFORCE_DEFINITION_AREAS.map(obligation => ({
    obligation, status: obligation === 'Governance and refusal rules' ? 'gap' : 'covered', explanation: 'Checked definition.', evidence,
  }));
  const finding = { obligation: 'Governance and refusal rules', kind: 'blocker',
    explanation: 'The Use Case does not settle escalation authority.', expectedEvidence: 'A confirmed escalation decision.', evidence };
  const payload = { complete: true, limitations: [], coverage, findings: [finding], resolutions: [] };
  const parse = (value: unknown) => parseReadinessReview(JSON.stringify(value), [spec], spec.id, checkedAt, scope);
  assert.deepEqual(parse(payload).findings[0]?.evidence,
    [{ sourceId: spec.id, revision: spec.revision, elementId: null, quote }]);
  assert.throws(() => parse({ ...payload, findings: [{ ...finding, kind: 'execution-prerequisite' }] }), /Invalid readiness finding/);
  assert.throws(() => parse({ ...payload, findings: [{ ...finding, evidence: [{ passageId: 'fabricated' }] }] }), /could not be verified/);
  assert.throws(() => parse({ ...payload, coverage: coverage.slice(1) }), /incomplete/);
});

test('full-demo approvals cannot carry over and scoped approval follows the current assessment', () => {
  const spec = source(quote);
  const fullFingerprint = readinessFingerprint([spec]);
  const scopedFingerprint = readinessFingerprint([spec], scope);
  const approval = { specId: spec.id, specRevision: spec.revision, approvedAt: checkedAt,
    ruleVersion: readinessVersions().ruleVersion, fingerprint: fullFingerprint };
  assert.equal(currentSpecApproval(approval, fullFingerprint, spec), true);
  assert.equal(currentSpecApproval(approval, scopedFingerprint, spec, scope, 'assessment'), false);
  const approvedDefinition = { ...approval, ruleVersion: readinessVersions(scope).ruleVersion, fingerprint: scopedFingerprint, assessmentId: 'assessment' };
  assert.equal(currentSpecApproval(approvedDefinition, scopedFingerprint, spec, scope, 'assessment'), true);
  assert.equal(currentSpecApproval(approvedDefinition, scopedFingerprint, spec, scope, 'reassessment'), false);
});
