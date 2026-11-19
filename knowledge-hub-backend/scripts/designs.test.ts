import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, mock } from 'node:test';
import JSZip from 'jszip';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { env } from '../src/config/env.js';
import { getFoundryClient } from '../src/ai/foundryClient.js';
import { GitHubClient } from '../src/integrations/github/githubClient.js';
import { assetDesigns, assetRole, attachAsset, createDesignSection, DESIGN_NOTE_MEMBERSHIPS_SQL, detachAsset, getDesign, listDesigns, parseAsset, selectDesignAsset, setSpecificationType, setImagineDemo, setImagineScope } from '../src/designs/designStore.js';
import { approveImagineSpec, readImagineHarness, requireImagineSpecApproval } from '../src/designs/imagineHarness.js';
import { parseImagineWorkforce, renderImagineWorkforce, validateImagineWorkforce, type ImagineWorkforce } from '../src/designs/imagineWorkforce.js';
import { textToBlocks } from '../src/ai/markdownToNoteBlocks.js';
import { noteMarkdown } from '../src/services/noteMarkdown.js';
import { writeDesignSpec } from '../src/designs/designSpec.js';
import { architectureDraft, type ImagineArchitectureBaseline } from '../src/designs/imagineArchitecture.js';
import { generateWorkforceSpecification, validateConfirmedDecisions } from '../src/designs/workforceSpecification.js';
import { WORKFORCE_DEFINITION_AREAS, WORKFORCE_DEFINITION_MARKER } from '../src/designs/workforceDefinitionScope.js';
import { demoSpecificationForm, demoSpecificationResponseSchema, DEMO_SPECIFICATION_VERSION } from '../src/ai/demoSpecification.js';
import { AiError } from '../src/types/errors.js';
import { collaboration, designModelContext, MAX_DESIGN_MODEL_CONTEXT, digest, parseBlueprint, parseChanges, queueFeedback, renderArtifact, resolveProposal, proposeFeedback, sameSources, sourceSnapshot } from '../src/designs/designArtifacts.js';
import { buildPublishedPackage, createPackage, packageArchive, preparePublication, publishPackage, validateDiagramSvg } from '../src/designs/designPackages.js';
import { acceptanceLocation, parseAcceptanceReport, readDesignAcceptance, setDesignAcceptanceSource } from '../src/designs/designWorkflow.js';
import { designBuildSource } from '../src/build/designSource.js';
import { AUTHORING_CONTRACT, authoredForModel, authoredTarget, parseAuthored, renderAuthored, selectionBelongs } from '../src/designs/visualArtifact.js';
import { DESIGN_CHAT_TOOLS, executeDesignTool, type DesignTurnState } from '../src/ai/designTools.js';
import { validateConsistencyFindings } from '../src/designs/designConsistency.js';
import { mechanicalReadiness, pageReadiness, parseReadinessReview, readinessPassages, readinessSnapshot, READINESS_RULE_VERSION, type ReadinessReport } from '../src/designs/designReadiness.js';
import { DEMO_SPECIFICATION_TEMPLATE } from '../src/ai/demoSpecificationTemplate.js';
import { hasNoteWriting } from '../src/utils/noteContent.js';

test('blank Design sections are distinct from writing, structured content and opaque saved data', () => {
  const note = (blocks: unknown[]) => JSON.stringify({ title: 'Spec', contentType: 'spec', contentJson: JSON.stringify(blocks) });
  assert.equal(hasNoteWriting(note([{ type: 'paragraph', content: [] }])), false);
  assert.equal(hasNoteWriting(note([{ type: 'paragraph', content: [{ type: 'text', text: '  ', styles: {} }] }])), false);
  for (const block of [
    { type: 'heading', content: [{ type: 'text', text: 'Authored heading' }] },
    { type: 'paragraph', content: [], children: [{ type: 'paragraph', content: 'Nested writing' }] },
    { type: 'image', props: { url: '/images/kept.png' } },
    { type: 'table', content: { rows: [] } },
    { type: 'paragraph', content: [{ type: 'noteMention', props: { id: ROOT } }] },
    { type: 'paragraph', content: [], props: { scriptDemo: '{"scenes":[]}' } },
  ]) assert.equal(hasNoteWriting(note([block])), true, JSON.stringify(block));
  assert.equal(hasNoteWriting('Saved legacy text'), true);
  assert.equal(hasNoteWriting('{"contentJson":"invalid"}'), true);
});

const ROOT = 'b028adff-5851-4203-915f-67f2ab889433';
const SPEC = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const checkedAt = '2026-11-01T21:37:00Z';
const baselineText = '# Platform contract\n\nStatus: proposed\n\nConsumer-owned deployment with service-owned data. Fabric SQL stores governed relational records; Cosmos DB stores operational documents. Foundry IQ supplies procedural knowledge; Fabric IQ supplies domain semantics.';
test('recommended Architecture only retains citations and quotations grounded in the actual pinned baseline', () => {
  const baseline: ImagineArchitectureBaseline = { repo: 'owner/imagine-base', commit: 'a'.repeat(40),
    sources: [{ id: 'BASE-1', path: 'infra/README.md', blob: 'b'.repeat(40), url: `https://github.com/owner/imagine-base/blob/${'a'.repeat(40)}/infra/README.md`, markdown: baselineText }] };
  const draft = { markdown: `# Recommended Architecture\n\n${'Proposed consumer-owned deployment; retain human authority and unresolved approval identities. '.repeat(3)}[BASE-1]`,
    evidence: [{ sourceId: 'BASE-1', quote: 'Consumer-owned deployment with service-owned data.' }] };
  const saved = architectureDraft(draft, baseline);
  assert.ok(saved.includes(baseline.sources[0]!.url));
  assert.match(saved, /not approval or a claim that services are deployed/);
  assert.throws(() => architectureDraft({ ...draft, evidence: [{ sourceId: 'BASE-1', quote: 'A deployment claim that is not in the supplied source.' }] }, baseline), /quotation absent/);
  assert.throws(() => architectureDraft({ ...draft, markdown: `${draft.markdown} [BASE-2]` }, baseline), /no verified baseline evidence/);
});
test('recommended Architecture verifies application citations and retains their separate pinned revision', () => {
  const application = { repo: 'owner/client-demo', commit: 'c'.repeat(40) };
  const source = { id: 'APP-1', path: 'owner/client-demo/docs/architecture-review.md', blob: 'd'.repeat(40),
    url: `https://github.com/${application.repo}/blob/${application.commit}/docs/architecture-review.md`,
    markdown: 'The application uses a Node.js Express API and Cosmos DB for operational records.' };
  const baseline: ImagineArchitectureBaseline = { repo: 'owner/imagine-base', commit: 'a'.repeat(40), application, sources: [source] };
  const draft = { markdown: `# Recommended Architecture\n\n${'Reuse the existing application API for proposed invoice case coordination, with persisted human waits and no commercial approval authority. '.repeat(2)}[APP-1]`,
    evidence: [{ sourceId: source.id, quote: 'Node.js Express API and Cosmos DB' }] };
  const saved = architectureDraft(draft, baseline);
  assert.ok(saved.includes(source.url));
  assert.ok(saved.includes(`Application: ${application.repo}. Reference commit: \`${application.commit}\``));
  assert.throws(() => architectureDraft({ ...draft, markdown: `${draft.markdown} [APP-2]` }, baseline), /no verified baseline evidence/);
  assert.throws(() => architectureDraft({ ...draft, evidence: [{ sourceId: source.id, quote: 'The invoice coordinator is already deployed.' }] }, baseline), /quotation absent/);
});
test('workforce specification uses only the bounded authoritative Use Case and server-authored scope structure', async () => {
  const useCase = `Northbridge Office Supplies / Pennfield Packaging.
PO-10482 is 100 kits at £10 each (£1,000). INV-20816 is 100 kits at £12 each (£1,200).
GR-10482 confirms all 100 kits received. The £200 price variance is 20%; there is no approved amendment.
A supplier claim is not approval. Analyze and compare, assess evidence, and recommend/draft a human request.
Never approve payment, amend the PO, accept the price, change bank details or send externally.
Prefer two or three digital workers, with justification.`;
  const confirmedDecisions = [
    'Propose six total members: orchestrator, Invoice Comparison, Evidence Assessment, Recommendation and Drafting, Accounts Payable Analyst, and Purchasing Owner.',
    'These are approved proposed members, not roles prescribed by the original Use Case. Keep the two human owners distinct from digital workers.',
  ];
  let request = '';
  let routeOptions: unknown;
  const model = mock.method(getFoundryClient('use-case-spec'), 'chatBulk', async (...args: unknown[]) => {
    request = (args[0] as { content: string }[])[1]!.content;
    routeOptions = args[6];
    return JSON.stringify({ sections: Object.fromEntries(WORKFORCE_DEFINITION_AREAS.map(area => [
      area, `Proposed design definition for ${area}. Preserve PO-10482, INV-20816, GR-10482, the £200 (20%) variance and human approval boundary.`,
    ])) });
  });
  try {
    const markdown = await generateWorkforceSpecification({
      title: 'Invoice Mismatch Resolution', designId: 'design-id', useCaseId: 'use-case-id',
      useCaseTitle: 'Invoice Use Case', useCase, confirmedDecisions,
    });
    const payload = JSON.parse(request) as {
      title: string; useCase: { title: string; markdown: string }; confirmedDecisions: string[];
    };
    assert.deepEqual(Object.keys(payload), ['title', 'useCase', 'confirmedDecisions'], 'prior derived Spec/Architecture are not included');
    assert.equal(payload.useCase.markdown, useCase, 'source facts are passed verbatim, not summarized or truncated');
    assert.deepEqual(payload.confirmedDecisions, confirmedDecisions, 'confirmed decisions are ordinary per-request generation input');
    assert.deepEqual(routeOptions, { requireDedicatedRoute: true }, 'workforce specification cannot fall back to the light bulk route');
    assert.deepEqual(validateConfirmedDecisions(confirmedDecisions), confirmedDecisions);
    assert.throws(() => validateConfirmedDecisions(['']), /non-empty string/);
    assert.throws(() => validateConfirmedDecisions(Array.from({ length: 13 }, () => 'decision')), /at most 12/);
    assert.ok(markdown.includes(WORKFORCE_DEFINITION_MARKER));
    for (const area of WORKFORCE_DEFINITION_AREAS) assert.ok(markdown.includes(`## ${area}\n`));
    assert.match(markdown, /PO-10482/);
    assert.match(markdown, /GR-10482/);
    assert.match(markdown, /£200 \(20%\)/);
    assert.match(markdown, /Source Use Case: \[Invoice Use Case\]/);
  } finally { model.mock.restore(); }
});
const acceptanceFixture = () => ({ version: 1, binding: null, scenario: 'claim-review', evidenceBasis: 'Saved repository report, not independent identity proof.',
  canPublish: false, candidate: { commit: 'a'.repeat(40), environment: 'demo', configurationFingerprint: 'config-1',
    backendRevision: 'api-1', frontendArtifact: 'web-1', workforceMemberIds: ['triage'],
    agents: [{ catalogueId: 'triage', deploymentId: 'deployment-1', definitionFingerprint: 'definition-1' }] },
  phases: ['initiation', 'workforce', 'offline', 'release', 'foundry', 'channels', 'operations', 'acceptance'].map(id => ({
    id, title: id, state: 'unknown', criteria: [{ id: `${id}:proof`, phase: id, title: 'Evidence required', kinds: ['receipt'],
      state: 'unknown', reasons: ['No verified receipt recorded.'], sources: [] }],
  })) });
test('repository acceptance preserves actual reported states and candidate identity without evaluating raw builder state', () => {
  const report = acceptanceFixture();
  report.phases[0]!.state = 'failed';
  assert.deepEqual(parseAcceptanceReport(report), report);
  assert.deepEqual(parseAcceptanceReport({ acceptance: { report, issues: [] } }), report);
  for (const invalid of [{ candidate: report.candidate, evidence: [] }, { ...report, phases: report.phases.slice(1) },
    { ...report, phases: report.phases.map(phase => ({ ...phase, state: 'approved' })) },
    { ...report, candidate: { ...report.candidate, commit: 'main' } },
    { ...report, candidate: { ...report.candidate, workforceMemberIds: [] } },
    { acceptance: { report: null } }]) assert.throws(() => parseAcceptanceReport(invalid), /No acceptance was inferred/);
});
test('report source URLs cannot redirect credentialed reads outside a GitHub repository file', () => {
  assert.deepEqual(acceptanceLocation('https://github.com/owner/repo/blob/feature%2Fdemo/evidence/report.json'), {
    repo: 'owner/repo', ref: 'feature/demo', path: 'evidence/report.json',
    url: 'https://github.com/owner/repo/blob/feature%2Fdemo/evidence/report.json',
  });
  for (const url of ['http://github.com/owner/repo/blob/main/report.json', 'https://example.com/owner/repo/blob/main/report.json',
    'https://github.com/owner/repo/blob/main/report.json?ref=other', 'https://github.com/owner/repo/blob/main/dir%2Freport.json',
    'https://github.com/owner/repo/blob/main/report.md', 'https://github.com:444/owner/repo/blob/main/report.json']) {
    assert.throws(() => acceptanceLocation(url), /Use an HTTPS/);
  }
});
const readinessSource = (markdown: string) => ({ id: SPEC, role: 'spec', revision: 2, title: 'Demo specification', markdown, blocks: [] });
const workforceFixture = (): ImagineWorkforce => ({
  scope: 'Proposed review workflow; no runtime deployment.',
  members: ['triage', 'reviewer'].map((id, index): ImagineWorkforce['members'][number] => ({ id, kind: index ? 'human' : 'agent', name: id, realAgentId: null,
    purpose: 'Review the supplied claim.', inputs: 'Claim and policy evidence.', outputs: 'Decision receipt for the customer.',
    tools: 'Proposed read-only policy search.', ownership: 'Claim owner; exact identity is an execution prerequisite.',
    authority: 'Only the reviewer can approve; the agent cannot publish.', escalation: 'Wait for human review if evidence is missing.',
    governance: 'Retain decision evidence; enforce claim scope.', observability: 'Proposed correlation ID and audit receipt.',
    evaluation: 'Assert no publication before review.', fidelity: index ? 'Human review' : 'Proposed synthetic policy agent',
    evidence: 'A policy agent hands the claim to a human reviewer before publication.' })),
  stages: [{ id: 'review', mode: 'journey', members: ['triage', 'reviewer'], entry: 'A new claim exists.',
    exit: 'The reviewer records a decision.', failure: 'Missing evidence waits for correction.' }],
  handoffs: [{ id: 'request-review', from: 'triage', to: 'reviewer', payload: 'Claim ID | grounded evidence',
    trigger: 'Triage completes.', mechanism: 'Proposed durable review task.', acceptance: 'Reviewer acknowledges the claim.',
    recovery: 'Retry the same task ID without duplicates.', protection: 'Reviewer-only decision, no agent approval.' }],
  prerequisites: ['Exact live identities and UI/runtime receipts remain unverified.'],
});
test('workforce contracts reject invented citations, bindings, graph references and unstable identities', () => {
  const data = workforceFixture();
  const sources = [readinessSource(data.members[0]!.evidence)];
  assert.deepEqual(validateImagineWorkforce(data, sources), data);
  const invalid = [
    { ...data, members: data.members.map(member => ({ ...member, evidence: 'An invented source quotation that was never supplied.' })) },
    { ...data, members: data.members.map(member => ({ ...member, realAgentId: 'invented-runtime-id' })) },
    { ...data, members: [data.members[0]!, data.members[0]!] },
    { ...data, stages: [{ ...data.stages[0]!, members: ['absent'] }] },
    { ...data, handoffs: [{ ...data.handoffs[0]!, to: 'absent' }] },
    { ...data, handoffs: [{ ...data.handoffs[0]!, recovery: 'TBD' }] },
    { ...data, handoffs: [] },
  ];
  for (const value of invalid) assert.throws(() => validateImagineWorkforce(value, sources), /Workforce validation/);
  const renamed = { ...data, members: [{ ...data.members[0]!, id: 'renamed' }, data.members[1]!] };
  assert.throws(() => validateImagineWorkforce(renamed, sources, data), /preserve the existing ID triage/);
});
test('editable workforce Markdown survives the real note conversion without losing handoff contracts', async () => {
  const data = workforceFixture();
  const sources = [readinessSource(data.members[0]!.evidence)];
  const markdown = renderImagineWorkforce(data);
  assert.deepEqual(parseImagineWorkforce(markdown, sources), data);
  const blocks = textToBlocks(markdown);
  const content = JSON.stringify({ title: 'Workforce', contentType: 'architecture', contentJson: JSON.stringify(blocks) });
  assert.deepEqual(parseImagineWorkforce(await noteMarkdown(content, OTHER), sources, blocks), data);
  assert.throws(() => parseImagineWorkforce(markdown.replace('Claim ID \\| grounded evidence', 'Claim ID | grounded evidence'), sources), /invalid table width/);
  assert.throws(() => parseImagineWorkforce(markdown.replace('## Journey', '## Missing journey'), sources), /Journey/);
});
test('Design source export preserves nested source captions and citation links', async () => {
  const blocks = [{ id: 'parent', type: 'paragraph', content: [{ type: 'text', text: 'Business requirement', styles: {} }], children: [
    { id: 'source', type: 'sourceCaption', props: {}, content: [
      { type: 'text', text: 'Reviewed ', styles: { italic: true } },
      { type: 'link', href: 'https://example.com/policy', content: [{ type: 'text', text: 'policy evidence', styles: {} }] },
    ], children: [] },
  ] }];
  const content = JSON.stringify({ title: 'Source-backed Design', contentType: 'design', contentJson: JSON.stringify(blocks) });
  const markdown = await noteMarkdown(content, ROOT);
  assert.match(markdown, /Business requirement/);
  assert.match(markdown, /Source: /);
  assert.match(markdown, /Reviewed/);
  assert.match(markdown, /\[policy evidence\]\(https:\/\/example.com\/policy\)/);
});
const reviewCoverage = (passageId: string, gap = false) => ['scenario', 'actors', 'fixtures', 'permissions', 'workforce', 'dependencies',
  'lifecycle', 'responses', 'screens', 'acceptance', 'traceability', 'authority'].map(obligation => ({
  obligation, status: gap && obligation === 'fixtures' ? 'gap' : 'covered', explanation: 'Located the relevant agreed content.',
  evidence: [{ passageId }],
}));

test('saved IMAGINE template checks retain exact obligations and distinguish live prerequisites', () => {
  const source = readinessSource(DEMO_SPECIFICATION_TEMPLATE);
  const checked = mechanicalReadiness(source, checkedAt);
  assert.equal(checked.complete, true);
  assert.ok(checked.findings.some(finding => finding.target.includes('Business problem') && finding.kind === 'blocker'));
  assert.ok(checked.findings.some(finding => finding.kind === 'execution-prerequisite'));
  const repeated = mechanicalReadiness(source, '2026-11-02T00:00:00Z');
  assert.deepEqual(checked.findings.map(finding => finding.id), repeated.findings.map(finding => finding.id));
  const duplicate = mechanicalReadiness(readinessSource(`${DEMO_SPECIFICATION_TEMPLATE}\n## 1. Duplicate\n`), checkedAt);
  assert.equal(duplicate.complete, false, 'ambiguous structure is not empty success');
  const fenced = mechanicalReadiness(readinessSource(`${DEMO_SPECIFICATION_TEMPLATE}\n\`\`\`md\n## 1. Example only\n\`\`\``), checkedAt);
  assert.equal(fenced.complete, true, 'example headings in code are not template sections');
  const missingSection = mechanicalReadiness(readinessSource('## 1. Business outcome\n'), checkedAt);
  assert.ok(missingSection.findings.some(finding => finding.rule === 'section:9' && finding.kind === 'blocker'));
});

test('semantic readiness requires actual citations and explicitly evidenced resolution', () => {
  const source = readinessSource('Fixtures will be added later.\nSynthetic starting record CASE-1: status=open.');
  const citation = { passageId: 'p1' };
  const finding = { obligation: 'fixtures', kind: 'blocker', explanation: 'A heading is not fixture records.',
    expectedEvidence: 'Concrete labelled starting records.', evidence: [citation] };
  const result = parseReadinessReview(JSON.stringify({ complete: true, limitations: [], coverage: reviewCoverage(citation.passageId, true), findings: [finding], resolutions: [] }), [source], SPEC, checkedAt);
  assert.equal(result.findings[0]?.origin, 'semantic');
  assert.equal(result.findings[0]?.evidence[0]?.revision, source.revision);
  assert.equal(result.findings[0]?.evidence[0]?.quote, 'Fixtures will be added later.');
  const resolved = parseReadinessReview(JSON.stringify({ complete: true, limitations: [], coverage: reviewCoverage('p2'), findings: [],
    resolutions: [{ obligation: 'fixtures', explanation: 'Starting data is recorded.', evidence: [{ passageId: 'p2' }] }] }), [source], SPEC, checkedAt);
  assert.ok(resolved.resolutions.has(result.findings[0]!.id));
  assert.throws(() => parseReadinessReview(JSON.stringify({ complete: true, limitations: [], coverage: reviewCoverage(citation.passageId, true),
    findings: [{ ...finding, evidence: [{ passageId: 'p999999' }] }], resolutions: [] }), [source], SPEC, checkedAt), /verified/);
  assert.throws(() => parseReadinessReview(JSON.stringify({ complete: true, limitations: [], coverage: reviewCoverage(citation.passageId, true),
    findings: [{ ...finding, evidence: [{ ...citation, quote: 'Invented data' }] }], resolutions: [] }), [source], SPEC, checkedAt), /not generated quotations/);
  assert.throws(() => parseReadinessReview(JSON.stringify({ complete: false, limitations: [], coverage: reviewCoverage(citation.passageId), findings: [], resolutions: [] }), [source], SPEC, checkedAt), /partial review/);
  assert.throws(() => parseReadinessReview(JSON.stringify({ complete: true, limitations: [], coverage: reviewCoverage(citation.passageId, true), findings: [finding, finding], resolutions: [] }), [source], SPEC, checkedAt), /duplicate/);
  assert.throws(() => parseReadinessReview(JSON.stringify({ complete: true, limitations: [], coverage: reviewCoverage(citation.passageId, true), findings: [finding],
    resolutions: [{ obligation: 'fixtures', explanation: 'Resolved.', evidence: [citation] }] }), [source], SPEC, checkedAt), /both open and resolved/);
});

test('readiness passages preserve saved wording and bind diagram evidence to textual elements', () => {
  const text = 'No actual sign-in userId or approved identity reference for the permitted publisher has been supplied.';
  const source = readinessSource(`${text}\n${'x'.repeat(4001)}`);
  const diagram = { id: OTHER, role: 'diagram', revision: 3, title: 'Flow', markdown: '', blocks: [],
    document: { nodes: [{ id: 'approval', label: 'Wait for the controller', description: 'Approval must precede publication.' }],
      edges: [{ id: 'proceed', label: 'Approved', from: 'approval', to: 'publication' }] } };
  const passages = readinessPassages([source, diagram]);
  assert.equal(passages[0]?.quote, text, 'the server copies the saved phrase without inserting a negation');
  assert.equal(passages.filter(passage => passage.sourceId === SPEC).slice(1).map(passage => passage.quote).join(''), 'x'.repeat(4001));
  assert.ok(passages.every(passage => passage.quote.length <= 1600));
  assert.equal(new Set(passages.map(passage => passage.passageId)).size, passages.length);
  assert.deepEqual(passages.filter(passage => passage.sourceId === OTHER).map(({ quote, elementId }) => ({ quote, elementId })),
    [{ quote: 'Wait for the controller', elementId: 'approval' }, { quote: 'Approval must precede publication.', elementId: 'approval' },
      { quote: 'Approved', elementId: 'proceed' }]);
});

test('readiness findings are separately paged without losing complete counts or freshness', () => {
  const findings = mechanicalReadiness(readinessSource(DEMO_SPECIFICATION_TEMPLATE), checkedAt).findings;
  assert.ok(findings.length > 20);
  const report: ReadinessReport = { id: ROOT, designRevision: 1, specId: SPEC, checkedAt,
    ruleVersion: READINESS_RULE_VERSION, templateVersion: 'imagine-demo-specification-v1', fingerprint: 'fingerprint',
    complete: true, limitations: [], coverage: [], sources: [], findings };
  const first = pageReadiness({ state: 'stale', sourceError: null, report, proposal: null });
  assert.equal(first.report?.findings.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.state, 'stale');
  assert.equal(first.counts.blockers + first.counts.executionPrerequisites, findings.length);
  assert.equal(pageReadiness({ state: 'blocked', sourceError: null, report, proposal: null }, 0, 'resolved').report?.findings.length, 0);
  assert.equal(pageReadiness({ state: 'not-assessed', sourceError: null, report: null, proposal: null }).report, null);
});
const writing = (title: string, contentType: string, text: string): string =>
  JSON.stringify({ title, contentType, contentJson: JSON.stringify([{ id: 'body', type: 'paragraph', content: [{ type: 'text', text, styles: { bold: true } }], children: [] }]) });
const blueprint = {
  title: 'Claims journey', explanation: 'Explore the evidence-led journey', openDecisions: [],
  elements: [
    { id: 'entry', kind: 'screen', title: 'Start claim', content: 'Review before submitting', sourceIds: [ROOT, SPEC], choices: ['Manual review'],
      components: [{ kind: 'field', label: 'Claim reference', detail: 'Reference', targetId: null }, { kind: 'button', label: 'Review', detail: '', targetId: 'review' }] },
    { id: 'review', kind: 'screen', title: 'Review claim', content: 'Evidence and next steps', sourceIds: [SPEC], choices: [],
      components: [{ kind: 'card', label: 'Evidence', detail: 'Verify the claim evidence', targetId: null }, { kind: 'button', label: 'Back', detail: '', targetId: 'entry' }] },
  ],
};

test('consistency findings require exact source quotations and cross-source contradictions', () => {
  const sources = [
    { id: ROOT, role: 'use_case', revision: 1, title: 'Use case', markdown: 'A human approves each payment.', blocks: [] },
    { id: SPEC, role: 'spec', revision: 2, title: 'Spec', markdown: 'Payments are approved automatically.', blocks: [] },
    { id: OTHER, role: 'diagram', revision: 3, title: 'Flow', markdown: '', blocks: [], document: {
      nodes: [{ id: 'human', label: 'Human approval', description: 'Check the payment.' }], edges: [],
    } },
  ];
  const evidence = [{ sourceId: ROOT, quote: 'A human approves each payment.', elementId: null },
    { sourceId: SPEC, quote: 'Payments are approved automatically.', elementId: null }];
  const finding = { kind: 'contradiction', explanation: 'Approval ownership conflicts.', evidence };
  assert.equal(validateConsistencyFindings({ findings: [finding] }, sources).length, 1);
  assert.throws(() => validateConsistencyFindings({ findings: [{ ...finding, evidence: [evidence[0]] }] }, sources), /two different/);
  assert.throws(() => validateConsistencyFindings({ findings: [{ ...finding, evidence: [{ ...evidence[0], quote: 'Invented quote' }, evidence[1]] }] }, sources), /verified/);
  assert.throws(() => validateConsistencyFindings({ findings: [{ ...finding, evidence: [{ sourceId: OTHER, quote: 'Human approval', elementId: 'missing' }, evidence[1]] }] }, sources), /verified/);
  assert.equal(validateConsistencyFindings({ findings: [{ ...finding, evidence: [{ sourceId: OTHER, quote: 'Human approval', elementId: 'human' }, evidence[1]] }] }, sources).length, 1);
  assert.throws(() => validateConsistencyFindings({}, sources), /incomplete/);
  const impact = { kind: 'impact', explanation: 'Revisit the specified approval step if the decision changes.', evidence: [evidence[0]] };
  assert.equal(validateConsistencyFindings({ findings: [impact] }, sources, true)[0]?.kind, 'impact');
  assert.throws(() => validateConsistencyFindings({ findings: [impact] }, sources), /contract/);
  assert.throws(() => validateConsistencyFindings({ findings: [{ ...impact, evidence: [{ ...evidence[0], quote: 'Not in the source' }] }] }, sources, true), /verified/);
  assert.throws(() => validateConsistencyFindings({ findings: [finding] }, sources, true), /contract/);
});

test('authored visuals are sanitised and must explain purpose, actors, an example and decisions', () => {
  const sources = [{ id: ROOT }, { id: SPEC }];
  const body = `<section data-element="how" onclick="steal()"><h1>How it works</h1><script>steal()</script><a href="javascript:steal()">link</a>
<svg viewBox="0 0 400 80" onload="steal()"><defs><marker id="arrow"><path d="M0 0L6 3L0 6z"/></marker></defs>
<g data-actor="automatic" data-actor-label="Athena"><rect width="120" height="40" style="fill:url(https://evil.example/x)"/><text x="10" y="24">Athena drafts</text></g>
<g data-actor="human" data-actor-label="Author"><rect x="200" width="120" height="40"/><text x="210" y="24">You approve</text></g><line x1="120" y1="20" x2="200" y2="20" marker-end="url(#arrow)"/></svg>
<ol><li data-actor="automatic" data-actor-label="Athena">Athena drafts the post.</li><li data-actor="human" data-actor-label="Author">You approve the exact text.</li></ol></section>
<section data-element="example"><h2>Example</h2><div data-walkthrough><div data-step="draft" data-step-title="Draft"><p>Athena drafts.</p><button data-goto="approve">Open draft</button><button>Publish now</button></div>
<div data-step="approve" data-step-title="Approve"><p>You approve.</p><input value="x"></div></div></section>`;
  const raw = (overrides: Record<string, unknown> = {}): string => JSON.stringify({ title: 'Publishing', purpose: 'Athena drafts posts; you approve them.', ask: 'Answer 1 decision.', body,
    regions: [{ id: 'how', title: 'How it works', role: 'flow', sourceIds: [SPEC] }, { id: 'example', title: 'Example', role: 'example', sourceIds: [SPEC] }],
    decisions: [{ id: 'landing', question: 'Where should approval start?', context: 'Sets the first screen.', recommended: 'Today',
      options: [{ label: 'Today', consequence: 'Athena shows pending approvals on Today.' }, { label: 'Discover', consequence: 'Approvals stay in Discover.' }], sourceIds: [SPEC] }], ...overrides });
  const { blueprint, removed } = parseAuthored(raw(), sources);
  assert.ok(removed >= 5);
  assert.ok(!/<script|onclick|onload|javascript:|evil\.example|<input|<a /.test(blueprint.body));
  assert.match(blueprint.body, /<h2>How it works<\/h2>/);
  assert.match(blueprint.body, /<button data-goto="approve">Open draft<\/button>/);
  assert.match(blueprint.body, /<span class="mock-button">Publish now<\/span>/);
  assert.match(blueprint.body, /marker-end="url\(#arrow\)"/);
  assert.deepEqual(blueprint.openDecisions, ['Where should approval start?']);
  assert.ok(selectionBelongs(authoredTarget(blueprint, 'how')!.text, 'Athena drafts the  post.'));
  assert.ok(!selectionBelongs(authoredTarget(blueprint, 'how')!.text, 'Something else'));
  assert.equal(authoredTarget(blueprint, 'landing')?.decision?.id, 'landing');
  const html = renderAuthored(blueprint, ROOT, 2);
  assert.match(html, /What I need from you:/);
  assert.match(html, /Go to the 1 decision/);
  assert.match(html, /Athena recommends/);
  assert.match(html, /connect-src 'none'/);
  assert.equal((html.match(/<script/g) ?? []).length, 2);
  assert.throws(() => parseAuthored(raw({ regions: [{ id: 'how', title: 'How', role: 'flow', sourceIds: [SPEC] }] }), sources), /undeclared region/);
  assert.throws(() => parseAuthored(raw({ body: body.replace('data-actor="human"', 'data-actor="you"') }), sources), /data-actor must classify/);
  assert.throws(() => parseAuthored(raw({ body: body.replace('<div data-step="approve" data-step-title="Approve">', '<div>') }), sources), /at least two/);
  assert.throws(() => parseAuthored(raw({ decisions: [{ id: 'x', question: 'Q', context: '', recommended: 'Maybe', options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], sourceIds: [SPEC] }] }), sources), /does not offer/);
  assert.throws(() => parseAuthored(raw({ body: `${body}<p>STATE_AWAITING_APPROVAL_V2</p>` }), sources), /internal state/);
});

test('IMAGINE Blueprint actors name digital workers and business roles, not the author', () => {
  const body = `<section data-element="flow"><h2>Flow</h2><svg viewBox="0 0 500 200">
<g data-actor="automatic" data-actor-label="Evidence Worker"><title>Evidence Worker</title><rect width="120" height="40"/><text>Evidence Worker checks evidence</text></g>
<g data-actor="automatic" data-actor-label="Close Steward"><title>Close Steward</title><rect y="60" width="120" height="40"/><text>Close Steward presents readiness</text></g>
<g data-actor="human" data-actor-label="Controller"><title>Controller</title><rect x="250" width="120" height="40"/><text>Controller authorises close</text></g>
<g data-actor="system" data-actor-label="Teams"><title>Teams</title><rect x="250" y="60" width="120" height="40"/><text>Teams delivers the interaction</text></g>
</svg><ol><li data-actor="automatic" data-actor-label="Evidence Worker">Evidence Worker checks evidence.</li>
<li data-actor="human" data-actor-label="Controller">Controller authorises close.</li></ol></section>
<section data-element="screens"><h2>Screens</h2><div data-walkthrough>
<div data-step="evidence" data-step-title="Evidence"><p>Evidence Worker produces the readiness pack.</p><button data-goto="approval">Review</button></div>
<div data-step="approval" data-step-title="Approval"><p>Controller reviews the pack in Teams.</p></div></div></section>`;
  const raw = (html = body): string => JSON.stringify({ title: 'Smart Close', purpose: 'Digital workers prepare close evidence for the Controller.',
    ask: 'Review the worker responsibilities.', body: html, decisions: [], regions: [
      { id: 'flow', title: 'Flow', role: 'flow', sourceIds: [SPEC] },
      { id: 'screens', title: 'Screens', role: 'screens', sourceIds: [SPEC] },
    ] });
  const sources = [{ id: SPEC }];
  const { blueprint } = parseAuthored(raw(), sources);
  for (const label of ['Evidence Worker', 'Close Steward', 'Controller', 'Teams']) {
    assert.ok(blueprint.body.includes(`data-actor-label="${label}"`));
  }
  assert.deepEqual(parseAuthored(JSON.stringify(authoredForModel(blueprint)), sources).blueprint, blueprint, 'feedback round trips preserve exact actor labels');
  const html = renderAuthored(blueprint, ROOT, 4);
  assert.match(html, /content:attr\(data-actor-label\)/);
  assert.match(html, /Automatic work/);
  assert.doesNotMatch(html, /Athena does this automatically|Athena · automatic|You decide or approve/);
  assert.throws(() => parseAuthored(raw(body.replace('data-actor="automatic"', 'data-actor="athena"')), sources), /data-actor must classify/);
  assert.doesNotThrow(() => parseAuthored(raw(body.replace(' data-actor-label="Evidence Worker"', '')), sources),
    'a visible actor name does not need duplicate label metadata');
  assert.throws(() => parseAuthored(raw(body.replace(' data-actor-label="Evidence Worker"', '').replace('<title>Evidence Worker</title>', '').replace('<text>Evidence Worker checks evidence</text>', '')), sources), /actor name in a label or visible text/);
  assert.throws(() => parseAuthored(raw(body.replace('data-actor-label="Evidence Worker"', 'data-actor-label=""')), sources), /source actor label/);
  assert.throws(() => parseAuthored(raw(body.replace('data-actor="automatic"', 'data-actor="invented"')), sources), /data-actor must classify/);
  assert.throws(() => parseAuthored(raw(body.replace(/ data-actor="[^"]*"/g, '').replace(/ data-actor-label="[^"]*"/g, '')), sources), /flow must identify/);
  assert.doesNotThrow(() => parseAuthored(raw(body.replace(/data-actor="human"/g, 'data-actor="automatic"')), sources),
    'a source-defined automated flow does not need an invented human gate');
  const escaped = parseAuthored(raw(body.replace('data-actor-label="Evidence Worker"', 'data-actor-label="Evidence &amp; Controls &lt;worker&gt;"')), sources);
  assert.match(escaped.blueprint.body, /data-actor-label="Evidence &amp; Controls &lt;worker&gt;"/);
  const historical = renderAuthored({ ...blueprint, body: blueprint.body.replace(/data-actor="automatic"/g, 'data-actor="athena"').replace(/data-actor="human"/g, 'data-actor="you"') }, ROOT, 3);
  assert.match(historical, /\[data-actor=athena\]/, 'old saved visuals keep actor styling without a database rewrite');
  assert.doesNotMatch(historical, /Athena does this automatically|Athena · automatic/);
  assert.match(AUTHORING_CONTRACT, /Athena is the Blueprint author, not automatically an actor/);
  assert.match(AUTHORING_CONTRACT, /For an IMAGINE specification, name the actual digital workers/);
  assert.match(AUTHORING_CONTRACT, /Correct those everywhere/);
  assert.match(AUTHORING_CONTRACT, /purpose, ask and each decision question ≤ 300/);
  assert.throws(() => parseAuthored(JSON.stringify({ ...JSON.parse(raw()), purpose: 'x'.repeat(301) }), sources), /purpose is missing or too long/);
  assert.doesNotMatch(AUTHORING_CONTRACT, /three horizontal lanes "You", "Athena"|what Athena does middle|If you choose this, Athena will/);
});

test('visual contracts reject unsafe types, ambiguous targets and overlapping anchors', () => {
  assert.equal(assetRole('spec'), 'spec');
  assert.throws(() => parseAsset({ sourceType: 'canvas', sourceId: OTHER, role: 'spec' }), /does not belong/);
  assert.throws(() => parseAsset({ sourceType: 'link', sourceId: 'javascript:alert(1)', role: 'reference' }), /HTTP/);
  const sources = [{ id: ROOT, role: 'use_case', title: 'Original', revision: 1, markdown: 'Original',
    blocks: [{ id: 'body', type: 'paragraph', content: 'Original', children: [{ id: 'child', type: 'paragraph', content: 'Preserved' }] }] },
  { id: SPEC, role: 'spec', title: 'Spec', revision: 1, markdown: 'Spec', blocks: [] }];
  const visual = parseBlueprint(JSON.stringify(blueprint), sources);
  const html = renderArtifact(visual, ROOT, 1);
  assert.match(html, /data-view="entry"/);
  assert.match(html, /data-view="review"/);
  assert.match(html, /<input placeholder="Reference"/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /data-annotate/);
  const hostile = parseBlueprint(JSON.stringify({ ...blueprint, title: '<script>steal()</script>' }), sources);
  assert.ok(!renderArtifact(hostile, ROOT, 1).includes('<script>steal()'));
  assert.throws(() => parseBlueprint(JSON.stringify({ ...blueprint, elements: [{ ...blueprint.elements[0], sourceIds: [OTHER] }] }), sources), /source mapping/);
  assert.throws(() => parseChanges(JSON.stringify({ explanation: 'Unsafe', changes: [{ noteId: OTHER, blockId: null, markdown: 'Injected' }] }), sources, new Set([ROOT])), /unlinked/);
  assert.throws(() => parseChanges(JSON.stringify({ explanation: 'Overlap', changes: [
    { noteId: ROOT, blockId: 'body', markdown: 'Parent' }, { noteId: ROOT, blockId: 'child', markdown: 'Child' },
  ] }), sources, new Set([ROOT])), /Overlapping/);
  assert.ok(parseChanges(JSON.stringify({ explanation: 'New requirement without matching prose', changes: [{ noteId: ROOT, blockId: null, markdown: '- Require explicit approval' }] }), sources, new Set([ROOT])).changes[0]?.after.length);
  validateDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" width="20" height="20"/></svg>');
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>',
  ]) assert.throws(() => validateDiagramSvg(svg));
});

test('Blueprint requests retain full large sources once, without changing editable snapshots', () => {
  const markdown = 'Full specification requirement.\n'.repeat(16_000);
  const blocks = [{ id: 'body', type: 'paragraph', content: markdown, children: [
    { id: 'mention', type: 'noteMention', props: { noteId: OTHER } },
    { id: 'image', type: 'image', props: { url: 'https://example.com/evidence.png' } },
  ] }];
  const sources = [
    { id: SPEC, role: 'spec', revision: 5, title: 'Complete spec', markdown, blocks },
    { id: ROOT, role: 'design', revision: 1, title: 'Empty source', markdown: 'Source heading', blocks: [] },
    { id: OTHER, role: 'diagram', revision: 2, title: 'Architecture', markdown: '', blocks: [], document: { nodes: [{ id: 'node' }] } },
  ];
  const original = JSON.stringify(sources);
  assert.ok(original.length > MAX_DESIGN_MODEL_CONTEXT);
  const previousVisual = { body: '<section>Previous Blueprint</section>' };
  const visual = JSON.parse(designModelContext(sources, 'visual', { previousVisual, brief: 'Keep all requirements' }));
  assert.equal(visual.sources[0].markdown, markdown);
  assert.equal('blocks' in visual.sources[0], false);
  assert.deepEqual(visual.sources[0], { id: SPEC, role: 'spec', revision: 5, title: 'Complete spec', markdown });
  assert.deepEqual(visual.sources[2].document, sources[2]!.document);
  assert.deepEqual(visual.previousVisual, previousVisual);
  const feedback = [{ instruction: 'Keep evidence and revise the requirement', element_id: 'overview' }];
  const review = JSON.parse(designModelContext(sources, 'review', { artifact: previousVisual, feedback, allowedIds: [SPEC] }));
  assert.deepEqual(review.sources[0].blocks, blocks);
  assert.equal('markdown' in review.sources[0], false);
  assert.equal(review.sources[1].markdown, 'Source heading');
  assert.deepEqual(review.sources[2].document, sources[2]!.document);
  assert.deepEqual(review.feedback, feedback);
  assert.deepEqual(review.allowedIds, [SPEC]);
  assert.equal(JSON.stringify(sources), original);
});

test('Blueprint context limits include the exact previous visual, feedback and allowed IDs payload', () => {
  for (const mode of ['visual', 'review'] as const) {
    const context = { previousVisual: { body: '' }, feedback: ['Feedback'], allowedIds: [SPEC] };
    const overhead = designModelContext([], mode, context).length;
    context.previousVisual.body = 'x'.repeat(MAX_DESIGN_MODEL_CONTEXT - overhead);
    assert.equal(designModelContext([], mode, context).length, MAX_DESIGN_MODEL_CONTEXT);
    context.previousVisual.body += 'x';
    assert.throws(() => designModelContext([], mode, context), /exceeds 750,000 characters.*nothing was truncated/);
  }
});

test('source comparison ignores JSONB object key order but rejects actual writing and revision changes', () => {
  const source = { id: ROOT, role: 'spec', revision: 1, title: 'Spec', markdown: 'Original', blocks: [{ id: 'body', type: 'paragraph', content: 'Original' }] };
  const stored = { blocks: [{ content: 'Original', type: 'paragraph', id: 'body' }], markdown: 'Original', title: 'Spec', revision: 1, role: 'spec', id: ROOT };
  assert.equal(sameSources([source], [stored]), true);
  assert.equal(sameSources([source], [{ ...stored, revision: 2 }]), false);
  assert.equal(sameSources([source], [{ ...stored, markdown: 'Edited' }]), false);
});

test('source section correction preserves originals and existing explicit non-use-case assignments', async () => {
  const local = new PGlite();
  try {
    await local.exec(`
      CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT);
      CREATE TABLE designs(id UUID PRIMARY KEY,source_note_id UUID,selections JSONB DEFAULT '{}',
        revision INTEGER DEFAULT 1,updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE design_assets(design_id UUID,source_type TEXT,source_id TEXT,role TEXT,excluded BOOLEAN,
        PRIMARY KEY(design_id,source_type,source_id));
    `);
    await local.query('INSERT INTO notes VALUES($1,$2)', [ROOT, writing('Client Report Assurance', 'use-case', 'High fidelity prototype specification')]);
    await local.query('INSERT INTO designs(id,source_note_id,selections) VALUES($1,$1,$2)', [ROOT, JSON.stringify({ use_case: ROOT })]);
    const sql = await readFile(new URL('../src/db/migrations/106_design_source_sections.sql', import.meta.url), 'utf8');
    await local.exec(sql);
    const { rows } = await local.query<{ role: string; selections: Record<string, string> }>(
      'SELECT a.role,d.selections FROM designs d JOIN design_assets a ON a.design_id=d.id');
    assert.equal(rows[0]?.role, 'spec');
    assert.deepEqual(rows[0]?.selections, {});
    assert.equal((await local.query<{ content: string }>('SELECT content FROM notes')).rows[0]?.content,
      writing('Client Report Assurance', 'use-case', 'High fidelity prototype specification'));
    await local.exec("UPDATE design_assets SET role='architecture'");
    await local.exec(sql);
    assert.equal((await local.query<{ role: string }>('SELECT role FROM design_assets')).rows[0]?.role, 'architecture');
  } finally { await local.close(); }
});

test('reference notes stay independent while document roles consistently drive grouping and Design navigation', async () => {
  const local = new PGlite();
  const reference = randomUUID();
  const secondParent = randomUUID();
  await local.exec(`
    CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT,status TEXT DEFAULT 'active',project_id TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE designs(id UUID PRIMARY KEY,parent_note_id UUID,source_note_id UUID,source_use_case_id UUID,
      summary TEXT DEFAULT '',status TEXT DEFAULT 'draft',revision INTEGER DEFAULT 1,specification_type TEXT,imagine_demo BOOLEAN DEFAULT false,
      imagine_scope TEXT NOT NULL DEFAULT 'full-demo',selections JSONB DEFAULT '{}');
    CREATE TABLE design_assets(design_id UUID,source_type TEXT,source_id TEXT,role TEXT,excluded BOOLEAN DEFAULT false,
      added_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(design_id,source_type,source_id));
    CREATE TABLE note_links(source_note_id UUID,target_note_id UUID);
    CREATE TABLE note_entity_links(source_note_id UUID,target_type TEXT,target_id TEXT);
    CREATE TABLE use_cases(id UUID,spec_note_id UUID);
    CREATE TABLE use_case_sources(use_case_id UUID,source_type TEXT,source_id TEXT);
    CREATE TABLE canvases(id UUID,title TEXT,canvas_type TEXT,deleted_at TIMESTAMPTZ);
    CREATE TABLE canvas_notes(canvas_id UUID,note_id TEXT);
    CREATE TABLE diagram_element_notes(canvas_id UUID,note_id TEXT);
  `);
  await local.exec(await readFile(new URL('../src/db/migrations/064_note_list_metadata.sql', import.meta.url), 'utf8'));
  await local.query('INSERT INTO notes(id,content) VALUES($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)', [
    ROOT, writing('Use case', 'use-case', 'Source'), SPEC, writing('Spec', 'spec', 'Specification'),
    reference, writing('Digital Steward', 'note', 'Shared reference'),
    OTHER, writing('Design', 'design', 'Parent'), secondParent, writing('Second Design', 'design', 'Parent'),
  ]);
  await local.query('INSERT INTO designs(id,parent_note_id,source_note_id) VALUES($1,$1,$2),($3,$3,$2)', [OTHER, ROOT, secondParent]);
  await local.query('INSERT INTO note_links VALUES($1,$2),($1,$3)', [ROOT, SPEC, reference]);
  const query = mock.method(getDb(), 'query', (sql: string, values?: unknown[]) => local.query(sql, values));
  const grouped = async (id: string) => (await local.query<{ parent_note_id: string }>(
    `SELECT parent_note_id FROM (${DESIGN_NOTE_MEMBERSHIPS_SQL}) memberships WHERE note_id=$1 ORDER BY parent_note_id`, [id])).rows;
  try {
    const before = (await local.query('SELECT id,content FROM notes ORDER BY id')).rows;
    assert.deepEqual(await assetDesigns(getDb(), 'note', reference), [],
      'Even multiple reference-only memberships must not redirect or ask for a parent');
    assert.deepEqual(await grouped(reference), []);
    assert.equal((await getDesign(getDb(), OTHER)).assets.find(asset => asset.sourceId === reference)?.role, 'reference',
      'The Design retains reference material and its links');
    for (const [id, role] of [[ROOT, 'use_case'], [SPEC, 'spec']]) {
      const membership = await assetDesigns(getDb(), 'note', id!);
      assert.equal(membership.length, 2);
      assert.ok(membership.every(item => item.role === role));
      assert.deepEqual(new Set(membership.map(item => item.parentNoteId)), new Set((await grouped(id!)).map(item => item.parent_note_id)));
    }
    await local.query("INSERT INTO design_assets(design_id,source_type,source_id,role) VALUES($1,'note',$2,'reference'),($3,'note',$2,'reference')",
      [OTHER, SPEC, secondParent]);
    assert.deepEqual(await assetDesigns(getDb(), 'note', SPEC), [], 'Explicit reference assignments override an inferred spec role');
    assert.deepEqual(await grouped(SPEC), []);
    await local.query("INSERT INTO design_assets(design_id,source_type,source_id,role) VALUES($1,'note',$2,'architecture')", [OTHER, reference]);
    assert.deepEqual((await assetDesigns(getDb(), 'note', reference)).map(item => item.parentNoteId), [OTHER],
      'An explicit document assignment still groups an ordinary note, ignoring its other reference-only parent');
    assert.deepEqual(await grouped(reference), [{ parent_note_id: OTHER }]);
    await local.query("UPDATE design_assets SET excluded=true WHERE design_id=$1 AND source_id=$2", [OTHER, reference]);
    assert.deepEqual(await assetDesigns(getDb(), 'note', reference), []);
    assert.deepEqual(await grouped(reference), []);
    assert.deepEqual((await local.query('SELECT id,content FROM notes ORDER BY id')).rows, before);
    assert.equal((await local.query('SELECT count(*)::int AS count FROM note_links')).rows[0]?.count, 2,
      'Visibility and navigation changes never remove note links or backlinks');
  } finally { query.mock.restore(); await local.close(); }
});

test('SCOPE-CONTRACT: Imagine scope defaults to full-demo and is explicitly revision-checked and persisted', async () => {
  const local = new PGlite();
  await local.exec(`
    CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT NOT NULL,status TEXT DEFAULT 'active',project_id TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE designs(id UUID PRIMARY KEY,parent_note_id UUID,title TEXT,summary TEXT DEFAULT '',project_id TEXT,
      source_use_case_id UUID,source_note_id UUID,status TEXT DEFAULT 'draft',revision INTEGER DEFAULT 1,updated_at TIMESTAMPTZ DEFAULT NOW(),
      specification_type TEXT,imagine_demo BOOLEAN NOT NULL DEFAULT false,imagine_harness JSONB NOT NULL DEFAULT '{}',selections JSONB NOT NULL DEFAULT '{}');
    CREATE TABLE design_assets(design_id UUID,source_type TEXT,source_id TEXT,role TEXT,excluded BOOLEAN DEFAULT false,added_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE note_links(source_note_id UUID,target_note_id UUID);
    CREATE TABLE note_entity_links(source_note_id UUID,target_type TEXT,target_id TEXT);
    CREATE TABLE use_cases(id UUID,spec_note_id UUID);
    CREATE TABLE use_case_sources(use_case_id UUID,source_type TEXT,source_id TEXT);
    CREATE TABLE canvases(id UUID,title TEXT,canvas_type TEXT,deleted_at TIMESTAMPTZ);
    CREATE TABLE canvas_notes(canvas_id UUID,note_id TEXT);
    CREATE TABLE diagram_element_notes(canvas_id UUID,note_id TEXT);
  `);
  await local.exec(await readFile(new URL('../src/db/migrations/064_note_list_metadata.sql', import.meta.url), 'utf8'));
  await local.query('INSERT INTO notes(id,content) VALUES($1,$2)', [OTHER, writing('Invoice Design', 'design', 'Preserve the source definition.')]);
  await local.query('INSERT INTO designs(id,parent_note_id,title,imagine_harness) VALUES($1,$1,$2,$3)',
    [OTHER, 'Invoice Design', JSON.stringify({ approval: { approved: true } })]);
  await local.exec(await readFile(new URL('../src/db/migrations/162_imagine_design_scope.sql', import.meta.url), 'utf8'));
  const query = mock.method(getDb(), 'query', async (sql: string, values?: unknown[]) => {
    const result = await local.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  });
  try {
    let design = await getDesign(getDb(), OTHER);
    assert.equal(design.imagineScope, 'full-demo', 'existing Designs retain the full-demo scope by default');
    await assert.rejects(setImagineScope(getDb(), design.id, { imagineScope: 'custom', expectedRevision: design.revision }), /Choose full-demo or workforce-definition/);
    await assert.rejects(setImagineScope(getDb(), design.id, { imagineScope: 'workforce-definition' }), /valid Design revision/);
    const before = design.revision;
    design = await setImagineScope(getDb(), design.id, { imagineScope: 'workforce-definition', expectedRevision: before });
    assert.equal(design.imagineScope, 'workforce-definition');
    await assert.rejects(createPackage(getDb(), design.id, {}), /outside its definition-only scope/);
    await assert.rejects(preparePublication(getDb(), design.id, SPEC, {}), /publication is outside/);
    await assert.rejects(publishPackage(getDb(), design.id, SPEC, ROOT, true), /publication is outside/);
    await assert.rejects(buildPublishedPackage(getDb(), design.id, SPEC, ROOT), /cannot create a software-build draft/);
    assert.deepEqual((await local.query('SELECT imagine_harness FROM designs WHERE id=$1', [OTHER])).rows[0]?.imagine_harness, {},
      'changing scope clears scope-bound approvals');
    await assert.rejects(setImagineScope(getDb(), design.id, { imagineScope: 'full-demo', expectedRevision: before }), /Design changed/);

    design = await setImagineDemo(getDb(), design.id, { imagineDemo: true, expectedRevision: design.revision });
    assert.equal(design.imagineScope, 'workforce-definition', 'demo-flag approval resets preserve explicit scope');
    await local.query('UPDATE notes SET content=$2,updated_at=NOW() WHERE id=$1',
      [OTHER, writing('Invoice Design', 'design', 'Edited source content.')]);
    assert.equal((await getDesign(getDb(), design.id)).imagineScope, 'workforce-definition', 'editor saves preserve explicit scope');
  } finally { query.mock.restore(); await local.close(); }
});

test('real parent conversion, source identity, persisted feedback, atomic acceptance and byte-identical coherent handoff', async () => {
  const local = new PGlite();
  await local.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,lifecycle_state TEXT DEFAULT 'active',updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE sparks(id UUID PRIMARY KEY,body TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tasks(id UUID PRIMARY KEY,title TEXT,archived BOOLEAN DEFAULT false,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE people(id UUID PRIMARY KEY,name TEXT,organisation TEXT,emails TEXT[],updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE companies(id UUID PRIMARY KEY,name TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE content_items(id UUID PRIMARY KEY,title TEXT,url TEXT,source TEXT,published_at TIMESTAMPTZ,indexed_at TIMESTAMPTZ);
    CREATE TABLE notes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),content TEXT NOT NULL,status TEXT DEFAULT 'active',
      project_id TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),
      tags TEXT[] DEFAULT '{}',linked_items UUID[] DEFAULT '{}');
    CREATE TABLE use_cases(id UUID PRIMARY KEY,title TEXT,summary TEXT,project_id TEXT,stage TEXT,spec_note_id UUID,updated_at TIMESTAMPTZ);
    CREATE TABLE use_case_sources(use_case_id UUID,source_type TEXT,source_id TEXT);
    CREATE TABLE canvases(id UUID PRIMARY KEY,title TEXT,project TEXT,canvas_type TEXT,deleted_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE canvas_diagrams(canvas_id UUID PRIMARY KEY,revision INTEGER,document JSONB);
    CREATE TABLE canvas_diagram_revisions(canvas_id UUID,revision INTEGER,document JSONB,PRIMARY KEY(canvas_id,revision));
    CREATE TABLE canvas_notes(canvas_id UUID,note_id TEXT);
    CREATE TABLE diagram_element_notes(canvas_id UUID,note_id TEXT);
    CREATE TABLE ai_chat_sessions(id UUID PRIMARY KEY,note_id TEXT,from_think BOOLEAN,project_id TEXT,title TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX session_note ON ai_chat_sessions(note_id) WHERE note_id IS NOT NULL;
    CREATE TABLE ai_chat_messages(id BIGSERIAL,session_id UUID,role TEXT,content TEXT);
  `);
  await local.exec('CREATE TABLE agent_jobs(id UUID PRIMARY KEY)');
  for (const file of ['054_ai_usage_log.sql', '067_ai_usage_measured.sql', '117_ai_workflow_attribution.sql']) {
    await local.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  for (const file of ['056_build_pipeline.sql', '057_build_integration_branch.sql', '060_note_history.sql', '061_note_github_publications.sql', '064_note_list_metadata.sql', '082_note_links.sql', '102_designs.sql', '103_design_note_origins.sql', '158_note_version_task_audit.sql']) {
    await local.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const original = writing('Claims', 'use-case', 'Original requirement');
  await local.query('INSERT INTO notes(id,content) VALUES($1,$2),($3,$4)', [ROOT, original, SPEC, writing('Claims spec', 'spec', 'Original specification')]);
  for (const file of ['104_design_note_artifacts.sql', '105_design_note_parent_trigger.sql', '111_design_specification_type.sql', '133_design_specification_readiness.sql', '160_imagine_design_harness.sql', '162_imagine_design_scope.sql']) await local.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  let failSecondWrite = false;
  let failArchitectureWrite: string | null = null;
  const query = async (sql: string, values?: unknown[]) => {
    if (failSecondWrite && sql.includes('UPDATE notes SET content') && values?.[0] === ROOT) throw new Error('Injected second-source failure');
    if (failArchitectureWrite && sql.includes('UPDATE notes SET content') && values?.[0] === failArchitectureWrite) throw new Error('Injected Architecture save failure');
    const result = await local.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const queryMock = mock.method(getDb(), 'query', query);
  const connectionMock = mock.method(getDb(), 'connect', async () => ({ query, release() {} }));
  let modelCalls = 0;
  const modelMock = mock.method(getFoundryClient('design-feedback'), 'chatBulk', async () => {
    modelCalls++;
    return JSON.stringify({ explanation: 'Add explicit approval without losing original context', visual: blueprint, changes: [
      { noteId: ROOT, blockId: 'body', markdown: '**Revised requirement**' },
      { noteId: SPEC, blockId: 'body', markdown: 'Revised specification with [evidence](https://example.com)' },
    ] });
  });
  try {
    const listed = await listDesigns(getDb());
    assert.equal(listed.items.length, 1);
    assert.notEqual(listed.items[0]!.parentNoteId, ROOT);
    let design = await getDesign(getDb(), ROOT);
    assert.equal(design.specificationType, null);
    await assert.rejects(writeDesignSpec(getDb(), design.id), /Choose Standard or IMAGINE/);
    for (const expectedRevision of [undefined, -1, 0.5, '0']) {
      await assert.rejects(setSpecificationType(getDb(), design.id, { specificationType: 'standard', expectedRevision }), /valid Design revision/);
    }
    await assert.rejects(setSpecificationType(getDb(), design.id, { specificationType: 'guessed', expectedRevision: design.revision }), /Standard or IMAGINE/);
    const initialRevision = design.revision;
    design = await setSpecificationType(getDb(), design.id, { specificationType: 'imagine', expectedRevision: initialRevision });
    assert.equal((await getDesign(getDb(), design.id)).specificationType, 'imagine');
    await assert.rejects(setSpecificationType(getDb(), design.id, { specificationType: 'standard', expectedRevision: initialRevision }), /Design changed/);
    assert.equal(design.sourceNoteId, ROOT);
    assert.equal((await local.query('SELECT content FROM notes WHERE id=$1', [ROOT])).rows[0]?.content, original);
    assert.equal((await local.query('SELECT count(*) AS n FROM notes')).rows[0]?.n, 3);
    design = await attachAsset(getDb(), design.parentNoteId, { sourceType: 'note', sourceId: SPEC, role: 'spec' });
    assert.equal(design.assets.find(asset => asset.sourceId === SPEC)?.role, 'spec');
    await assert.rejects(attachAsset(getDb(), design.id, { sourceType: 'note', sourceId: design.parentNoteId, role: 'spec' }), /cannot link itself/);
    await assert.rejects(detachAsset(getDb(), design.id, { sourceType: 'note', sourceId: ROOT }), /original source note remains linked/);
    await assert.rejects(selectDesignAsset(getDb(), design.id, { role: 'spec', sourceId: SPEC, expectedRevision: 0 }), /changed/);
    design = await selectDesignAsset(getDb(), design.id, { role: 'spec', sourceId: SPEC, expectedRevision: design.revision });
    assert.equal(design.imagineDemo, false, 'existing Designs do not opt into the new workflow');
    await assert.rejects(setImagineDemo(getDb(), design.id, { imagineDemo: 'yes', expectedRevision: design.revision }), /whether this Design/);
    const beforeFlag = design.revision;
    design = await setImagineDemo(getDb(), design.id, { imagineDemo: true, expectedRevision: beforeFlag });
    assert.equal(design.specificationType, 'imagine', 'the separate flag preserves the specification setting');
    await assert.rejects(setImagineDemo(getDb(), design.id, { imagineDemo: false, expectedRevision: beforeFlag }), /Design changed/);
    await assert.rejects(requireImagineSpecApproval(getDb(), design.id), /user must approve/);
    assert.equal((await readImagineHarness(getDb(), design.id)).canApprove, false);
    const checkedSources = await readinessSnapshot(getDb(), design);
    const report: ReadinessReport = { id: randomUUID(), specId: SPEC, designRevision: design.revision, checkedAt,
      ruleVersion: READINESS_RULE_VERSION, templateVersion: DEMO_SPECIFICATION_VERSION,
      fingerprint: digest(JSON.stringify(checkedSources)), complete: true, coverage: [], limitations: [], sources: [], findings: [] };
    await local.query('INSERT INTO design_readiness_assessments(id,design_id,report,snapshots) VALUES($1,$2,$3,$4)',
      [report.id, design.id, JSON.stringify(report), JSON.stringify(checkedSources)]);
    const gate = await readImagineHarness(getDb(), design.id);
    assert.equal(gate.canApprove, true);
    await assert.rejects(approveImagineSpec(getDb(), design.id, {
      expectedRevision: design.revision, expectedSpecRevision: -1, assessmentId: report.id,
    }), /current, fully validated/);
    const approved = await approveImagineSpec(getDb(), design.id, {
      expectedRevision: design.revision, expectedSpecRevision: gate.specRevision, assessmentId: report.id,
    });
    assert.equal(approved.specApproved, true);
    await requireImagineSpecApproval(getDb(), design.id);
    await local.query('UPDATE notes SET revision=revision+1 WHERE id=$1', [ROOT]);
    assert.equal((await readImagineHarness(getDb(), design.id)).specApproved, false, 'a handwritten source edit invalidates approval even when the spec itself is unchanged');
    await assert.rejects(requireImagineSpecApproval(getDb(), design.id), /Changed sources require/);
    design = await setImagineDemo(getDb(), design.id, { imagineDemo: false, expectedRevision: design.revision });
    const populated = writing('Populated', 'note', 'Never lose this writing');
    await local.query('INSERT INTO notes(id,content) VALUES($1,$2)', [OTHER, populated]);
    const converted = { ...JSON.parse(populated), contentType: 'design' };
    await local.query('UPDATE notes SET content=$2 WHERE id=$1', [OTHER, JSON.stringify(converted)]);
    const real = await getDesign(getDb(), OTHER);
    assert.equal(real.parentNoteId, OTHER, 'type changes preserve the original ID');
    assert.equal(JSON.parse(String((await local.query('SELECT content FROM notes WHERE id=$1', [OTHER])).rows[0]?.content)).contentJson, JSON.parse(populated).contentJson);
    const handwritten = await sourceSnapshot(getDb(), real);
    assert.equal(handwritten.length, 1, 'the handwritten original is not duplicated as Design background');
    assert.equal(handwritten[0]?.id, OTHER);
    assert.equal(handwritten[0]?.role, 'use_case');
    assert.match(handwritten[0]!.markdown, /Never lose this writing/);
    await assert.rejects(detachAsset(getDb(), real.id, { sourceType: 'note', sourceId: OTHER }), /cannot be unlinked/);
    const startedSpec = await createDesignSection(getDb(), real.id, { role: 'spec', expectedRevision: real.revision });
    const startedArchitecture = await createDesignSection(getDb(), real.id, { role: 'architecture', expectedRevision: startedSpec.design.revision });
    const startedDiagram = await createDesignSection(getDb(), real.id, { role: 'diagram', expectedRevision: startedArchitecture.design.revision });
    const sectionIds = startedDiagram.design.assets.map(asset => asset.sourceId);
    assert.equal(new Set(sectionIds).size, 4, 'each section has its own stable identity');
    assert.equal(startedSpec.notes.length, 1);
    assert.equal(startedSpec.design.assets.find(asset => asset.role === 'spec')?.hasContent, false, 'a blank section is not a generated specification');
    assert.equal(startedSpec.design.assets.find(asset => asset.sourceId === OTHER)?.hasContent, true, 'the handwritten use case remains real writing');
    assert.equal(startedArchitecture.notes.length, 1);
    assert.equal(startedDiagram.notes.length, 0);
    assert.deepEqual((await sourceSnapshot(getDb(), startedDiagram.design)).find(source => source.role === 'spec')?.blocks,
      [{ type: 'paragraph', content: [] }], 'new section writing is empty; Markdown export still includes provenance');
    assert.equal((await sourceSnapshot(getDb(), startedDiagram.design)).find(source => source.role === 'use_case')?.markdown, handwritten[0]!.markdown);
    await assert.rejects(createDesignSection(getDb(), real.id, { role: 'spec', expectedRevision: real.revision }), /Design changed/);
    await assert.rejects(createDesignSection(getDb(), real.id, { role: 'spec', expectedRevision: startedDiagram.design.revision }), /already has content/);
    const legacyParentId = randomUUID();
    const legacySpecification = writing('Existing specification', 'design', 'Preserve the specification in its existing original.');
    await local.query('INSERT INTO notes(id,content) VALUES($1,$2)', [legacyParentId, legacySpecification]);
    await local.query("INSERT INTO design_assets(design_id,source_type,source_id,role) VALUES($1,'note',$2,'spec')", [legacyParentId, legacyParentId]);
    const legacy = await getDesign(getDb(), legacyParentId);
    assert.equal(legacy.assets.find(asset => asset.sourceId === legacyParentId)?.role, 'spec', 'a pre-existing Spec is never relabelled as a Use case');
    const withUseCase = await createDesignSection(getDb(), legacy.id, { role: 'use_case', expectedRevision: legacy.revision });
    assert.notEqual(withUseCase.design.assets.find(asset => asset.role === 'use_case')?.sourceId, legacyParentId);
    assert.equal((await local.query('SELECT content FROM notes WHERE id=$1', [legacyParentId])).rows[0]?.content, legacySpecification);

    const sources = await sourceSnapshot(getDb(), design);
    const visual = parseBlueprint(JSON.stringify(blueprint), sources);
    const artifactId = randomUUID();
    await local.query('INSERT INTO design_artifacts(id,design_id,revision,sources,blueprint,html) VALUES($1,$2,1,$3,$4,$5)',
      [artifactId, design.id, JSON.stringify(sources), JSON.stringify(visual), renderArtifact(visual, artifactId, 1)]);
    let visualContent = '';
    let visualOffset: number | null = 0;
    do {
      const page = await executeDesignTool(getDb(), 'read_design_blueprint', design.parentNoteId, { artifactId, offset: visualOffset }, {}) as {
        content: string; nextOffset: number | null; revision: number;
      };
      assert.ok(page.content.length <= 12_000, 'Blueprint retrieval remains bounded');
      assert.equal(page.revision, 1);
      visualContent += page.content;
      visualOffset = page.nextOffset;
    } while (visualOffset !== null);
    assert.deepEqual(JSON.parse(visualContent), visual, 'Athena reads the actual saved visual, not title-only context');
    await assert.rejects(executeDesignTool(getDb(), 'read_design_blueprint', design.parentNoteId, { artifactId: randomUUID() }, {}), /Blueprint changed/);
    await assert.rejects(executeDesignTool(getDb(), 'read_design_blueprint', design.parentNoteId, { artifactId, offset: -1 }, {}), /offset/);
    const feedbackInput = { requestId: randomUUID(), artifactId, elementId: 'entry', selection: '', instruction: '  Require approval before submission.  ' };
    await assert.rejects(executeDesignTool(getDb(), 'queue_design_blueprint_feedback', design.parentNoteId, feedbackInput, { readOnly: true }), /read-only/);
    const queued = await executeDesignTool(getDb(), 'queue_design_blueprint_feedback', design.parentNoteId, feedbackInput, {}) as { feedbackId: string; note: string };
    const feedback = await queueFeedback(getDb(), design.id, feedbackInput);
    assert.equal(queued.feedbackId, feedback.id, 'Athena and the normal review queue share the same saved feedback');
    assert.match(queued.note, /No Blueprint or source writing changed/);
    assert.equal(feedback.instruction, feedbackInput.instruction, 'retain exact user input');
    assert.equal((await queueFeedback(getDb(), design.id, feedbackInput)).id, feedback.id);
    await assert.rejects(queueFeedback(getDb(), design.id, { ...feedbackInput, instruction: 'Changed retry' }), /different input/);
    const before = await local.query('SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[ROOT, SPEC]]);
    const proposal = await proposeFeedback(getDb(), design.id);
    assert.equal(modelCalls, 1);
    assert.deepEqual((await local.query('SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[ROOT, SPEC]])).rows, before.rows, 'proposing never writes sources');
    await assert.rejects(proposeFeedback(getDb(), design.id), /existing proposal|Queue feedback/);
    assert.equal(modelCalls, 1);
    assert.equal((await local.query("SELECT count(*) AS n FROM ai_chat_messages WHERE role='user'")).rows[0]?.n, 1, 'feedback reaches the existing Athena conversation exactly once');
    await local.query('UPDATE notes SET revision=revision+1 WHERE id=$1', [SPEC]);
    await assert.rejects(resolveProposal(getDb(), design.id, proposal.id, true), /changed|stale/i);
    await local.query('UPDATE notes SET revision=revision-1 WHERE id=$1', [SPEC]);
    failSecondWrite = true;
    await assert.rejects(resolveProposal(getDb(), design.id, proposal.id, true), /second-source failure/);
    assert.deepEqual((await local.query('SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[ROOT, SPEC]])).rows, before.rows, 'failed multi-source acceptance rolls back every original');
    assert.equal((await local.query("SELECT status FROM design_proposals WHERE id=$1", [proposal.id])).rows[0]?.status, 'pending');
    failSecondWrite = false;
    await resolveProposal(getDb(), design.id, proposal.id, true);
    const accepted = await collaboration(getDb(), design.id);
    assert.equal(accepted.feedback[0]?.status, 'accepted');
    assert.equal(accepted.artifact?.revision, 2, 'accepted Markdown and revised artifact commit together');
    assert.equal(accepted.stale, false);
    assert.equal((await local.query('SELECT count(*) AS n FROM note_versions WHERE note_id=ANY($1::uuid[])', [[ROOT, SPEC]])).rows[0]?.n, 2, 'both originals have history checkpoints');
    const secondFeedback = await queueFeedback(getDb(), design.id, { ...feedbackInput, requestId: randomUUID(), artifactId: accepted.artifact!.id });
    const discarded = await proposeFeedback(getDb(), design.id);
    const beforeDiscard = (await local.query('SELECT id,content,revision FROM notes ORDER BY id')).rows;
    await resolveProposal(getDb(), design.id, discarded.id, false);
    assert.deepEqual((await local.query('SELECT id,content,revision FROM notes ORDER BY id')).rows, beforeDiscard);
    assert.equal((await local.query('SELECT status FROM design_feedback WHERE id=$1', [secondFeedback.id])).rows[0]?.status, 'discarded');

    const snapshot = await createPackage(getDb(), design.id, {});
    assert.equal(snapshot.manifest.ready, false);
    assert.ok(snapshot.manifest.missingInputs.includes('architecture'));
    assert.ok(snapshot.files['use-case.md']?.includes('Revised requirement'));
    assert.ok(snapshot.files['specification.md']?.includes('[evidence](https://example.com)'));
    assert.ok(snapshot.files['visual-design.html']?.includes('data-view="review"'));
    assert.match(snapshot.files['README.md']!, /Pending or discarded feedback is NOT an accepted requirement/);
    const archive = await JSZip.loadAsync(await packageArchive(snapshot));
    for (const file of snapshot.manifest.files) {
      const bytes = await archive.file(`design/${file.path}`)!.async('string');
      assert.equal(bytes, snapshot.files[file.path]);
      assert.equal(digest(bytes), file.sha256);
    }
    const gh = new GitHubClient();
    let ref = 'base';
    let treeEntries: Array<{ path: string; sha: string; type: string; mode: string }> = [{ path: 'unrelated.md', sha: 'unrelated', type: 'blob', mode: '100644' }];
    let postedFiles: Record<string, string> = {};
    const ghGet = mock.method(gh, 'get', async (path: string) => {
      if (path === '/repos/owner/repo') return { full_name: 'owner/repo', default_branch: 'main', permissions: { push: true } };
      if (path.includes('/git/ref/heads/')) return { object: { sha: ref } };
      if (path.endsWith('/git/commits/base')) return { sha: 'base', tree: { sha: 'base-tree' } };
      if (path.includes('/git/trees/')) return { sha: 'tree', truncated: false, tree: treeEntries };
      throw new Error(`Unexpected mocked GET ${path}`);
    });
    const credential = mock.getter(env, 'GITHUB_ACCESS_TOKEN', () => 'fixture-token');
    const ghGetOptional = mock.method(gh, 'getOptional', async (path: string) => {
      if (path === '/repos/owner/repo') return { full_name: 'owner/repo', default_branch: 'main', permissions: { push: true } };
      const prefix = '/repos/owner/repo/contents/design/';
      if (path.startsWith(prefix)) {
        const content = postedFiles[path.slice(prefix.length)];
        return content === undefined ? null : { encoding: 'base64', content: Buffer.from(content).toString('base64') };
      }
      throw new Error(`Unexpected mocked optional GET ${path}`);
    });
    const ghPost = mock.method(gh, 'post', async (path: string, body: { base_tree?: string; tree?: Array<{ path: string; content: string }>; parents?: string[] }) => {
      if (path.endsWith('/git/trees')) {
        assert.equal(body.base_tree, 'base-tree');
        postedFiles = Object.fromEntries(body.tree!.map(file => [file.path.replace(/^design\//, ''), file.content]));
        treeEntries = [...treeEntries, ...body.tree!.map(file => ({ path: file.path, sha: createHash('sha1').update(`blob ${Buffer.byteLength(file.content)}\0`).update(file.content).digest('hex'), type: 'blob', mode: '100644' }))];
        return { sha: 'new-tree' };
      }
      assert.deepEqual(body.parents, ['base']);
      return { sha: 'published-commit' };
    });
    let patches = 0;
    const ghPatch = mock.method(gh, 'patch', async (_: string, body: { sha: string; force: boolean }) => { assert.equal(body.force, false); ref = body.sha; patches++; return { object: { sha: ref } }; });
    try {
      await assert.rejects(preparePublication(getDb(), design.id, snapshot.id, { repo: 'owner/repo', folder: '../escape' }, gh));
      const publication = await preparePublication(getDb(), design.id, snapshot.id, { repo: 'owner/repo', folder: 'design' }, gh);
      await assert.rejects(publishPackage(getDb(), design.id, snapshot.id, publication.id, false, gh), /Confirm/);
      ref = 'changed';
      await assert.rejects(publishPackage(getDb(), design.id, snapshot.id, publication.id, true, gh), /changed/);
      assert.equal(patches, 0);
      ref = 'base';
      const result = await publishPackage(getDb(), design.id, snapshot.id, publication.id, true, gh);
      assert.match(result.commitUrl, /published-commit$/);
      assert.deepEqual(postedFiles, snapshot.files, 'download and GitHub receive the same immutable bytes');
      assert.ok(treeEntries.some(entry => entry.path === 'unrelated.md'));
      assert.equal(patches, 1);
      await publishPackage(getDb(), design.id, snapshot.id, publication.id, true, gh);
      assert.equal(patches, 1, 'retry verifies the prior commit without republishing');
      design = await setImagineDemo(getDb(), design.id, { imagineDemo: true, expectedRevision: (await getDesign(getDb(), design.id)).revision });
      const imagineSnapshot = await createPackage(getDb(), design.id, {});
      assert.ok(!imagineSnapshot.manifest.missingInputs.includes('diagram'), 'Imagine diagrams are optional');
      assert.ok(imagineSnapshot.manifest.missingInputs.includes('workforce'), 'the separate workforce design is required');
      const unconfirmed = await preparePublication(getDb(), design.id, imagineSnapshot.id, { repo: 'owner/repo', folder: 'design' }, gh);
      await assert.rejects(buildPublishedPackage(getDb(), design.id, imagineSnapshot.id, unconfirmed.id), /Publish and verify/);
      const build = await buildPublishedPackage(getDb(), design.id, snapshot.id, publication.id);
      assert.equal(build.status, 'draft');
      assert.ok(build.specMarkdown.includes(snapshot.id) && build.specMarkdown.includes('published-commit'));
      for (const path of Object.keys(snapshot.files)) assert.ok(build.specMarkdown.includes(`design/${path}`), path);
      const sourceContent = await designBuildSource(getDb(), build);
      assert.deepEqual(JSON.parse(sourceContent!).files, snapshot.files, 'planning gets actual full package content, not links alone');
      await assert.rejects(designBuildSource(getDb(), build, { excludedIds: new Set([SPEC]) }), /excluded/);
      await assert.rejects(designBuildSource(getDb(), { ...build, repo: 'another/repo' }), /no longer matches/);
      await local.query("UPDATE build_specs SET spec_markdown='Manually revised draft' WHERE id=$1", [build.id]);
      assert.equal((await buildPublishedPackage(getDb(), design.id, snapshot.id, publication.id)).id, build.id,
        'retry cannot duplicate a draft after its user edits');
      design = await setImagineDemo(getDb(), design.id, { imagineDemo: false, expectedRevision: design.revision });
    } finally { credential.mock.restore(); ghGet.mock.restore(); ghGetOptional.mock.restore(); ghPost.mock.restore(); ghPatch.mock.restore(); }

    assert.deepEqual(DESIGN_CHAT_TOOLS.map(tool => tool.function.name), [
      'read_imagine_blueprint_mapping', 'create_imagine_workforce_blueprint', 'set_design_imagine_scope',
      'read_design_build', 'read_design_workflow', 'read_design_acceptance', 'set_design_acceptance_source', 'create_design_build_draft',
      'read_design_blueprint', 'queue_design_blueprint_feedback',
      'check_imagine_workforce', 'read_imagine_harness', 'set_design_imagine_demo',
      'read_design_readiness_repair', 'read_design_readiness', 'read_design_readiness_history',
      'check_design_readiness', 'prepare_design_readiness_repair', 'discard_design_readiness_repair',
      'read_design_package', 'save_design_documents',
    ]);
    const chatState: DesignTurnState = { changedNoteIds: [] };
    const owner = design.parentNoteId;
    await assert.rejects(executeDesignTool(getDb(), 'save_design_documents', owner, {}, {}, chatState), /Read the current Design/);
    await assert.rejects(executeDesignTool(getDb(), 'read_design_package', owner, {}, { excludedIds: new Set([ROOT]) }, chatState), /excluded/);
    await executeDesignTool(getDb(), 'read_design_package', owner, {}, {}, chatState);
    const source = chatState.read!.sources.find(item => item.id === ROOT)!;
    const count = (await local.query<{ n: number }>('SELECT count(*)::int AS n FROM notes')).rows[0]!.n;
    const documents = [
      { role: 'use_case', noteId: ROOT, expectedRevision: source.revision, title: source.title,
        markdown: null, changes: [{ blockId: 'body', markdown: '**Clarified goal and user journey**' }] },
      { role: 'architecture', noteId: null, expectedRevision: null, title: 'Claims architecture',
        markdown: '# Claims architecture\n\nPreserve the linked sources.', changes: [] },
    ];
    const request = { expectedDesignRevision: chatState.read!.revision, documents };
    await assert.rejects(executeDesignTool(getDb(), 'save_design_documents', owner, {
      ...request, documents: [{ ...documents[0], noteId: OTHER }],
    }, {}, chatState), /identity changed/);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await executeDesignTool(getDb(), 'save_design_documents', owner, request, {}, chatState);
      assert.equal((await local.query<{ n: number }>('SELECT count(*)::int AS n FROM notes')).rows[0]!.n, count + 1,
        'Only the truly missing section creates a new note');
      const current = await getDesign(getDb(), owner);
      assert.equal(current.assets.find(asset => asset.role === 'use_case')!.sourceId, ROOT, 'Existing original stays authoritative');
      assert.equal(current.assets.filter(asset => asset.role === 'architecture').length, 1);
      assert.ok(current.selections.architecture);
      assert.equal(chatState.changedNoteIds.length, 2);
      assert.equal(chatState.read, undefined, 'Another save must read the new revisions');
      const history = await local.query<{ reason: string }>("SELECT reason FROM note_versions WHERE note_id=$1 ORDER BY created_at DESC LIMIT 1", [ROOT]);
      assert.equal(history.rows[0]?.reason, 'before_athena');

      await executeDesignTool(getDb(), 'read_design_package', owner, {}, {}, chatState);
      const beforeFailure = (await local.query('SELECT id,content,revision FROM notes ORDER BY id')).rows;
      const changedSources = chatState.read!.sources.filter(item => item.role === 'use_case' || item.role === 'spec');
      failSecondWrite = true;
      await assert.rejects(executeDesignTool(getDb(), 'save_design_documents', owner, {
        expectedDesignRevision: chatState.read!.revision, documents: changedSources.map(item => ({
          role: item.role, noteId: item.id, expectedRevision: item.revision, title: item.title, markdown: 'Must roll back', changes: [],
        })),
      }, {}, chatState), /Injected second-source failure/);
      failSecondWrite = false;
      assert.deepEqual((await local.query('SELECT id,content,revision FROM notes ORDER BY id')).rows, beforeFailure);
      await local.query('UPDATE notes SET revision=revision+1 WHERE id=$1', [SPEC]);
      await assert.rejects(executeDesignTool(getDb(), 'save_design_documents', owner, {
        expectedDesignRevision: chatState.read!.revision, documents: [{
          role: 'use_case', noteId: ROOT, expectedRevision: changedSources.find(item => item.id === ROOT)!.revision,
          title: source.title, markdown: 'Reject stale context', changes: [],
        }],
      }, {}, chatState), /source changed/);
    } finally { failSecondWrite = false; mock.timers.reset(); }

    await local.exec(`
      ALTER TABLE projects
        ADD COLUMN description TEXT DEFAULT '', ADD COLUMN goal TEXT DEFAULT '',
        ADD COLUMN role TEXT DEFAULT '', ADD COLUMN ownership TEXT DEFAULT '',
        ADD COLUMN start_date DATE, ADD COLUMN target_end_date DATE,
        ADD COLUMN importance TEXT DEFAULT 'normal', ADD COLUMN priority TEXT DEFAULT 'normal',
        ADD COLUMN category TEXT DEFAULT 'work', ADD COLUMN project_type TEXT DEFAULT 'project',
        ADD COLUMN expected_outputs TEXT[] DEFAULT '{}', ADD COLUMN links JSONB DEFAULT '[]',
        ADD COLUMN gitlab_paths TEXT[] DEFAULT '{}', ADD COLUMN github_repos TEXT[] DEFAULT '{}',
        ADD COLUMN tags TEXT[] DEFAULT '{}', ADD COLUMN has_ica_document_collection BOOLEAN DEFAULT false,
        ADD COLUMN ica_document_collection_name TEXT DEFAULT '', ADD COLUMN ica_document_collection_id TEXT DEFAULT '';
      CREATE TABLE company_projects(company_id UUID,project_id TEXT,role TEXT);
      CREATE TABLE project_offering_links(project_id TEXT,offering_id TEXT,relation TEXT);
      INSERT INTO projects(id,name,description) VALUES('imagine-context','Imagine','The fixture platform separates workforce designs from runtime agents.');
    `);
    await local.query('UPDATE notes SET project_id=$1 WHERE id=$2', ['imagine-context', design.parentNoteId]);
    await local.query("UPDATE projects SET github_repos=ARRAY['owner/repo'] WHERE id='imagine-context'");
    let evidenceDesign = await getDesign(getDb(), design.id);
    evidenceDesign = await setImagineDemo(getDb(), design.id, { imagineDemo: true, expectedRevision: evidenceDesign.revision });
    const reportUrl = 'https://github.com/owner/repo/blob/main/evidence/report.json';
    await assert.rejects(setDesignAcceptanceSource(getDb(), design.id, { url: reportUrl, expectedRevision: -1 }), /Design changed/);
    await assert.rejects(setDesignAcceptanceSource(getDb(), design.id, {
      url: 'https://github.com/elsewhere/repo/blob/main/report.json', expectedRevision: evidenceDesign.revision,
    }), /configured GitHub repositories/);
    evidenceDesign = await setDesignAcceptanceSource(getDb(), design.id, { url: reportUrl, expectedRevision: evidenceDesign.revision });
    assert.equal(evidenceDesign.selections.reference, reportUrl);
    const repoReport = acceptanceFixture();
    repoReport.phases[0]!.criteria[0]!.reasons = ['A retained repository explanation. '.repeat(400)];
    const bytes = JSON.stringify(repoReport);
    const evidenceGet = mock.method(GitHubClient.prototype, 'get', async (path: string, params?: Record<string, string>) => {
      if (path === '/repos/owner/repo/commits/main') return { sha: 'f'.repeat(40) };
      assert.equal(path, '/repos/owner/repo/contents/evidence/report.json');
      assert.equal(params?.['ref'], 'f'.repeat(40), 'report content is pinned to the resolved commit, not a moving main');
      return { type: 'file', encoding: 'base64', content: Buffer.from(bytes).toString('base64'), size: Buffer.byteLength(bytes), sha: 'b'.repeat(40) };
    });
    try {
      const read = await readDesignAcceptance(getDb(), design.id);
      assert.deepEqual(read.report, repoReport);
      assert.equal(read.source?.commit, 'f'.repeat(40));
      const evidenceState: DesignTurnState = { changedNoteIds: [] };
      let offset: number | null = 0;
      let sourceCommit: string | null = null;
      let json = '';
      do {
        const page = await executeDesignTool(getDb(), 'read_design_acceptance', design.parentNoteId,
          { offset, sourceCommit }, {}, evidenceState) as { json: string; sourceCommit: string; nextOffset: number | null };
        assert.ok(page.json.length <= 12_000);
        json += page.json; offset = page.nextOffset; sourceCommit = page.sourceCommit;
      } while (offset !== null);
      assert.deepEqual(JSON.parse(json).report, repoReport, 'Athena retrieves actual criterion content across immutable report chunks');
      await assert.rejects(executeDesignTool(getDb(), 'set_design_acceptance_source', design.parentNoteId, {
        url: reportUrl, expectedRevision: evidenceDesign.revision,
      }, { readOnly: true }), /read-only/);
      await assert.rejects(executeDesignTool(getDb(), 'read_design_acceptance', design.parentNoteId, { offset: 0, sourceCommit: null },
        { excludedIds: new Set([reportUrl]) }), /excluded/);
    } finally { evidenceGet.mock.restore(); }
    await setImagineDemo(getDb(), design.id, { imagineDemo: false, expectedRevision: evidenceDesign.revision });
    await assert.rejects(writeDesignSpec(getDb(), design.id, true), /exactly one imagine-base repository/);
    await local.query("UPDATE projects SET github_repos=ARRAY['owner/repo','owner/imagine-base'] WHERE id='imagine-context'");
    const architectureId = (await sourceSnapshot(getDb(), await getDesign(getDb(), design.id))).find(item => item.role === 'architecture')!.id;
    const architectureBefore = (await local.query<{ content: string }>('SELECT content FROM notes WHERE id=$1', [architectureId])).rows[0]!;
    const baselineGet = mock.method(GitHubClient.prototype, 'get', async (path: string, params?: Record<string, string>) => {
      if (path === '/repos/owner/imagine-base/commits/HEAD') return { sha: 'a'.repeat(40) };
      assert.match(path, /^\/repos\/owner\/imagine-base\/contents\/(?:infra|docs\/decisions)\//);
      assert.equal(params?.['ref'], 'a'.repeat(40), 'all baseline files come from the same immutable commit');
      return { type: 'file', encoding: 'base64', content: Buffer.from(baselineText).toString('base64'),
        size: Buffer.byteLength(baselineText), sha: 'b'.repeat(40) };
    });
    let architectureFailure = false;
    let architectureCalls = 0;
    const architectureMock = mock.method(getFoundryClient('design-architecture'), 'chatBulk', async (...args: unknown[]) => {
      architectureCalls++;
      const input = JSON.parse((args[0] as { content: string }[])[1]!.content) as {
        specification: string; baseline: ImagineArchitectureBaseline; scope?: string;
      };
      if (input.scope === 'workforce-definition') {
        assert.ok(input.specification.includes('Specification contract: imagine-workforce-specification-v1'));
        assert.equal((input.specification.match(/^## /gm) ?? []).length, 9);
        assert.doesNotMatch(input.specification, /LEGACY_FULL_DEMO_SPEC_DO_NOT_FEED/);
      } else {
        assert.equal((input.specification.match(/^## \d+\./gm) ?? []).length, 10, 'Architecture receives the complete newly generated Spec');
      }
      assert.equal(input.baseline.sources.length, 9);
      assert.ok(input.baseline.sources.every(source => source.markdown === baselineText));
      if (architectureFailure) throw new AiError('Injected Architecture generation failure');
      return JSON.stringify({ markdown: `# Recommended Architecture\n\n${'Proposed service-owned records, consumer-owned deployment and human approval; no deployed identities are inferred. '.repeat(3)}[BASE-1]`,
        evidence: [{ sourceId: 'BASE-1', quote: 'Consumer-owned deployment with service-owned data.' }] });
    });
    let response: string | null = null;
    let lastCall: unknown[] = [];
    const requestedSections: number[][] = [];
    let timeoutOnce = true;
    let changeTypeDuringGeneration = false;
    let changeContextDuringGeneration = false;
    const writerMock = mock.method(getFoundryClient('use-case-spec'), 'chatBulk', async (...args: unknown[]) => {
      lastCall = args;
      const messages = args[0] as { content: string }[];
      if (messages[0]!.content.includes('bounded, design-time Imagine workforce specification')) {
        const request = JSON.parse(messages[1]!.content) as { title: string; useCase: { title: string; markdown: string } };
        assert.deepEqual(Object.keys(request), ['title', 'useCase']);
        assert.ok(request.useCase.markdown.includes('Northbridge Office Supplies / Pennfield Packaging'));
        assert.ok(request.useCase.markdown.includes('PO-10482'));
        assert.ok(request.useCase.markdown.includes('INV-20816'));
        assert.ok(request.useCase.markdown.includes('GR-10482'));
        assert.ok(!messages[1]!.content.includes('LEGACY_FULL_DEMO_SPEC_DO_NOT_FEED'));
        return JSON.stringify({ sections: Object.fromEntries(WORKFORCE_DEFINITION_AREAS.map(area => [
          area, `Proposed design definition for ${area}. Preserve PO-10482, INV-20816, GR-10482, the £200 (20%) variance and human approval boundary.`,
        ])) });
      }
      assert.ok((args[0] as { content: string }[])[1]!.content.includes('The fixture platform separates workforce designs from runtime agents.')
        || (args[0] as { content: string }[])[1]!.content.includes('The platform context has changed.'));
      if (changeContextDuringGeneration) {
        await local.query('UPDATE projects SET description=$1 WHERE id=$2', ['The platform context has changed.', 'imagine-context']);
      }
      if (changeTypeDuringGeneration) {
        const current = await getDesign(getDb(), design.id);
        await setSpecificationType(getDb(), design.id, { specificationType: 'imagine', expectedRevision: current.revision });
      }
      if (response !== null) return response;
      const request = JSON.parse((args[0] as { content: string }[])[1]!.content) as { sections: number[] };
      requestedSections.push(request.sections);
      if (request.sections[0] === 3 && timeoutOnce) { timeoutOnce = false; throw new AiError('Bulk request timed out after 270000ms'); }
      const form = demoSpecificationForm(request.sections) as { fields: { id: string }[]; tables: { id: string }[] };
      return JSON.stringify({
        name: 'Claims',
        values: Object.fromEntries(form.fields.map(field => [field.id, `Unresolved - confirm ${field.id} with the owner before implementation.`])),
        additionalRows: Object.fromEntries(form.tables.map(table => [table.id, []])),
        sectionDetails: Object.fromEntries(request.sections.map(section => [String(section), 'Proposed - reviewer confirms the applicable business rules before implementation.'])),
      });
    });
    try {
      const imagined = await writeDesignSpec(getDb(), design.id, true);
      assert.equal(imagined.noteId, SPEC, 'regeneration updates the selected spec in place');
      assert.equal(imagined.architectureNoteId, architectureId, 'regeneration preserves the selected Architecture ID');
      assert.deepEqual(new Set(imagined.notes.map(note => note.id)), new Set([SPEC, architectureId]), 'both saved documents reach the normal indexing/publication caller');
      assert.ok((await local.query("SELECT 1 FROM note_versions WHERE note_id=$1 AND writing->>'contentJson'=$2",
        [architectureId, (JSON.parse(architectureBefore.content) as { contentJson: string }).contentJson])).rows.length,
        'the previous Architecture remains in normal note history');
      assert.match((await sourceSnapshot(getDb(), await getDesign(getDb(), design.id))).find(item => item.id === architectureId)!.markdown,
        /Verified baseline references/);
      assert.deepEqual(lastCall[4], demoSpecificationResponseSchema([10]));
      assert.deepEqual(requestedSections, [[1], [2], [3], [3], [4], [5], [6], [7], [8], [9], [10]], 'only the timed-out section is regenerated');
      const imaginedSource = (await sourceSnapshot(getDb(), await getDesign(getDb(), design.id))).find(item => item.id === SPEC)!;
      assert.equal((imaginedSource.markdown.match(/^## \d+\./gm) ?? []).length, 10);
      assert.doesNotMatch(imaginedSource.markdown, /Source conversation:/);
      const beforePairFailure = (await local.query('SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[SPEC, architectureId]])).rows;
      architectureFailure = true;
      await assert.rejects(writeDesignSpec(getDb(), design.id, true), /Injected Architecture generation failure/);
      architectureFailure = false;
      assert.deepEqual((await local.query('SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[SPEC, architectureId]])).rows,
        beforePairFailure, 'Architecture generation failure leaves both saved originals unchanged');
      failArchitectureWrite = architectureId;
      await assert.rejects(writeDesignSpec(getDb(), design.id, true), /Injected Architecture save failure/);
      failArchitectureWrite = null;
      assert.deepEqual((await local.query('SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[SPEC, architectureId]])).rows,
        beforePairFailure, 'a failure saving Architecture rolls back the preceding Spec save');
      response = '{}';
      const beforeInvalid = (await local.query('SELECT content,revision FROM notes WHERE id=$1', [SPEC])).rows;
      await assert.rejects(writeDesignSpec(getDb(), design.id, true), /incomplete or invalid/);
      assert.deepEqual((await local.query('SELECT content,revision FROM notes WHERE id=$1', [SPEC])).rows, beforeInvalid);
      const current = await getDesign(getDb(), design.id);
      await setSpecificationType(getDb(), design.id, { specificationType: 'standard', expectedRevision: current.revision });
      response = '# Standard claims specification\n\n## Requirements\n\nThe reviewer must approve the evidence before submission.';
      const beforeStandard = architectureCalls;
      assert.equal((await writeDesignSpec(getDb(), design.id, true)).architectureNoteId, null);
      assert.equal(architectureCalls, beforeStandard, 'Standard generation never generates Architecture');
      assert.equal(lastCall[4], undefined, 'Standard retains the product-spec writer');
      const beforeConflict = (await local.query('SELECT content,revision FROM notes WHERE id=$1', [SPEC])).rows;
      changeContextDuringGeneration = true;
      await assert.rejects(writeDesignSpec(getDb(), design.id, true), /workstream context changed/);
      assert.deepEqual((await local.query('SELECT content,revision FROM notes WHERE id=$1', [SPEC])).rows, beforeConflict);
      changeContextDuringGeneration = false;
      changeTypeDuringGeneration = true;
      await assert.rejects(writeDesignSpec(getDb(), design.id, true), /Design.*changed/);
      assert.deepEqual((await local.query('SELECT content,revision FROM notes WHERE id=$1', [SPEC])).rows, beforeConflict);
      changeTypeDuringGeneration = false;
      response = null;
      const invoiceUseCase = `Northbridge Office Supplies / Pennfield Packaging.
PO-10482: 100 kits at £10 each = £1,000. INV-20816: 100 kits at £12 each = £1,200.
GR-10482 confirms all 100 kits were received. Price variance: £200 (20%). There is no approved amendment.
A supplier claim is not approval. Analyze and compare, assess evidence, and recommend/draft a human request.
Never approve payment, amend the PO, accept the price, change bank details or send externally.
Prefer two or three digital workers, with justification.`;
      await local.query('UPDATE notes SET content=$1,revision=revision+1 WHERE id=$2', [
        JSON.stringify({ title: 'Invoice Mismatch Resolution', contentType: 'use-case',
          contentJson: JSON.stringify(textToBlocks(invoiceUseCase)) }), ROOT,
      ]);
      const priorDocuments = await local.query<{ id: string; content: string; revision: number }>(
        'SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[SPEC, architectureId]]);
      let beforeScopeDesign = await getDesign(getDb(), design.id);
      if (beforeScopeDesign.specificationType !== 'imagine') {
        beforeScopeDesign = await setSpecificationType(getDb(), design.id, {
          specificationType: 'imagine', expectedRevision: beforeScopeDesign.revision,
        });
      }
      await setImagineScope(getDb(), design.id, {
        imagineScope: 'workforce-definition', expectedRevision: (await getDesign(getDb(), design.id)).revision,
      });
      const consistency = mock.method(getFoundryClient('design-readiness'), 'chatBulk', async () => JSON.stringify({ unresolved: [], edits: [] }));
      const scoped = await writeDesignSpec(getDb(), design.id, true).finally(() => consistency.mock.restore());
      assert.notEqual(scoped.noteId, SPEC, 'workforce-definition always creates a distinct Spec');
      assert.notEqual(scoped.architectureNoteId, architectureId, 'workforce-definition always creates a distinct Architecture');
      assert.equal(scoped.created, true);
      assert.deepEqual(new Set(scoped.notes.map(note => note.id)), new Set([scoped.noteId, scoped.architectureNoteId]));
      assert.deepEqual((await local.query<{ id: string; content: string; revision: number }>(
        'SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[SPEC, architectureId]])).rows,
      priorDocuments.rows, 'the previous full-demo Spec and Architecture are preserved byte-for-byte');
      const selectedScopedDesign = await getDesign(getDb(), design.id);
      assert.equal(selectedScopedDesign.selections.spec, scoped.noteId);
      assert.equal(selectedScopedDesign.selections.architecture, scoped.architectureNoteId);
      assert.ok(selectedScopedDesign.assets.some(asset => asset.sourceId === SPEC && asset.role === 'spec'));
      assert.ok(selectedScopedDesign.assets.some(asset => asset.sourceId === architectureId && asset.role === 'architecture'));
      const scopedSources = await sourceSnapshot(getDb(), selectedScopedDesign);
      const scopedSpec = scopedSources.find(source => source.id === scoped.noteId)!;
      assert.equal(scopedSpec.markdown.split('\n').filter(line => line === WORKFORCE_DEFINITION_MARKER).length, 1,
        'the literal contract marker survives named linking to the Imagine project and the saved note Markdown export');
      assert.deepEqual((scopedSpec.markdown.match(/^## (?:Member properties|Governance and refusal rules|Orchestration and handoffs|Hierarchy|Ownership|Observability definitions|Dependencies and composition|Design-time coverage and maturity|Evaluation definitions)$/gm) ?? []).length, 9);
      assert.match(scopedSpec.markdown, /£200 \(20%\)/);
      assert.match(scopedSpec.markdown, /Source Use Case: /);
      assert.equal(architectureCalls, beforeStandard + 1, 'scoped generation creates its own recommended Architecture');
    } finally { failArchitectureWrite = null; writerMock.mock.restore(); architectureMock.mock.restore(); baselineGet.mock.restore(); }
  } finally { modelMock.mock.restore(); queryMock.mock.restore(); connectionMock.mock.restore(); await local.close(); }
});
