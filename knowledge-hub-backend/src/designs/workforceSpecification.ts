import { getFoundryClient } from '../ai/foundryClient.js';
import { withAiStage } from '../ai/aiWorkflow.js';
import { ValidationError } from '../types/errors.js';
import {
  WORKFORCE_DEFINITION_AREAS,
  WORKFORCE_DEFINITION_MARKER,
} from './workforceDefinitionScope.js';

const MAX_SOURCE_CHARS = 40_000;
const MAX_SECTION_CHARS = 8_000;
const MAX_SPECIFICATION_CHARS = 50_000;
const MAX_CONFIRMED_DECISIONS = 12;
const MAX_CONFIRMED_DECISION_CHARS = 1_000;
const MAX_CONFIRMED_DECISIONS_TOTAL_CHARS = 5_000;
export const WORKFORCE_SPECIFICATION_STYLE_VERSION = 'concise-definition-v2';

const areaProperties = Object.fromEntries(WORKFORCE_DEFINITION_AREAS.map(area => [area, {
  type: 'string',
  minLength: 40,
  maxLength: MAX_SECTION_CHARS,
}]));

export const WORKFORCE_SPECIFICATION_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sections: {
      type: 'object',
      additionalProperties: false,
      properties: areaProperties,
      required: [...WORKFORCE_DEFINITION_AREAS],
    },
  },
  required: ['sections'],
};

export function validateWorkforceSpecificationMarkdown(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_SPECIFICATION_CHARS
    || !raw.includes(WORKFORCE_DEFINITION_MARKER)) {
    throw new ValidationError('The retained workforce specification checkpoint is invalid.');
  }
  const headings = [...raw.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  if (headings.length !== WORKFORCE_DEFINITION_AREAS.length
    || WORKFORCE_DEFINITION_AREAS.some(area => headings.filter(heading => heading === area).length !== 1)) {
    throw new ValidationError('The retained workforce specification checkpoint does not contain the complete definition contract.');
  }
  return raw;
}

export function validateConfirmedDecisions(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_CONFIRMED_DECISIONS) {
    throw new ValidationError(`Provide at most ${MAX_CONFIRMED_DECISIONS} confirmed workforce decisions.`);
  }
  const decisions = raw.map((value: unknown) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_CONFIRMED_DECISION_CHARS) {
      throw new ValidationError(`Each confirmed workforce decision must be a non-empty string of at most ${MAX_CONFIRMED_DECISION_CHARS} characters.`);
    }
    return value.trim();
  });
  if (decisions.reduce((total, item) => total + item.length, 0) > MAX_CONFIRMED_DECISIONS_TOTAL_CHARS) {
    throw new ValidationError(`Confirmed workforce decisions must total at most ${MAX_CONFIRMED_DECISIONS_TOTAL_CHARS} characters.`);
  }
  return decisions;
}

const WORKFORCE_SPECIFICATION_SYSTEM = `Create a bounded, design-time Imagine workforce specification from the single authoritative Use Case supplied by the user message.
Return JSON matching the supplied schema. The server authors the title, scope marker, boundary, source links and exact section headings; return only substantive section bodies.
Preserve every real business fact, identifier, example, amount, date, threshold, role, authority limit, exception and unresolved decision supplied by the Use Case. Do not replace concrete source facts with generic summaries, invent values or import requirements from prior derived documents.
Describe a proposed workforce, not a prescribed original roster: distinguish source-required roles from recommendations, explain the member-count trade-off, and retain any stated preference for two or three digital workers unless the source explicitly resolves it otherwise. Treat separately supplied confirmed decisions as proposals, not original Use Case facts. Separate digital workers from human decision owners.
Define member capabilities, limitations and typed inputs/outputs; governance and refusal behavior; trigger, ordering/parallelism, typed handoffs, human waits and specified failure/recovery paths; reporting hierarchy distinct from step order; execution ownership, decision authority and escalation; proposed observability event/correlation fields; dependencies, services, composition and a design-time bill of materials; design-time coverage and maturity; and evaluation cases/assertions.
Keep the complete specification concise: aim for 1,500-2,000 words across all nine sections. Use compact Markdown tables for member comparisons, typed handoffs and acceptance cases; these become editable rich-text tables in the document editor. Define each packet and shared rule once and reference it elsewhere. Sender outputs must match receiver inputs, including human clarification.
Keep each supplied example's concrete facts together in one acceptance case instead of repeating them per member. State the minimum useful audit trail rather than exhaustive telemetry fields, event taxonomies, operational metrics or runtime schemas. Keep technology decisions in the Architecture and defer speculative infrastructure.
Budget the Member properties section across all proposed members before writing. Give each digital and human member the same concise property set (purpose, responsibilities, typed inputs and outputs, permitted sources, authority limits, escalation). Put shared rules and worked examples in their relevant other sections instead of repeating them per member. Finish every member and sentence within the section limit.
Use only the nine requested areas. Do not produce a full demo or software specification, deployment/build instructions, runtime implementation, generated telemetry, execution results, synthetic records, UI/channel implementation or claims that runtime controls are enforced. Proposed tools, services and data integrations are design definitions, not connected or provisioned resources. Human approval remains authoritative for consequential actions.`;

export function renderWorkforceSpecification(
  raw: unknown,
  input: { title: string; designId: string; useCaseId: string; useCaseTitle: string },
): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('The workforce specification response is invalid. No document was saved.');
  }
  const response = raw as Record<string, unknown>;
  const sections = response['sections'];
  if (Object.keys(response).length !== 1 || !sections || typeof sections !== 'object' || Array.isArray(sections)) {
    throw new ValidationError('The workforce specification response must contain only the requested sections. No document was saved.');
  }
  const sectionValues = sections as Record<string, unknown>;
  if (Object.keys(sectionValues).length !== WORKFORCE_DEFINITION_AREAS.length
    || WORKFORCE_DEFINITION_AREAS.some(area => typeof sectionValues[area] !== 'string'
      || (sectionValues[area] as string).trim().length < 40
      || (sectionValues[area] as string).length > MAX_SECTION_CHARS)) {
    throw new ValidationError('The workforce specification is incomplete or exceeds its section limits. No document was saved.');
  }
  const areaText = WORKFORCE_DEFINITION_AREAS
    .map(area => `## ${area}\n\n${(sectionValues[area] as string).trim()}`).join('\n\n');
  const markdown = [
    `# Workforce Specification: ${input.title}`,
    WORKFORCE_DEFINITION_MARKER,
    'Define an undeployed Imagine workforce: its members, evidence, handoffs, human decisions and acceptance cases. This document does not authorise deployment, execution, evaluation runs or demo creation.',
    `Source Use Case: [${input.useCaseTitle}](/think?noteId=${encodeURIComponent(input.useCaseId)})`,
    `Design: [${input.title}](/think?design=${encodeURIComponent(input.designId)})`,
    areaText,
  ].join('\n\n');
  if (markdown.length > MAX_SPECIFICATION_CHARS) {
    throw new ValidationError('The workforce specification exceeds its total size limit. No document was saved.');
  }
  return validateWorkforceSpecificationMarkdown(markdown);
}

export async function generateWorkforceSpecification(input: {
  title: string;
  designId: string;
  useCaseId: string;
  useCaseTitle: string;
  useCase: string;
  confirmedDecisions?: readonly string[];
}, signal?: AbortSignal): Promise<string> {
  if (!input.useCase.trim() || input.useCase.length > MAX_SOURCE_CHARS) {
    throw new ValidationError('The authoritative Use Case is empty or exceeds the workforce specification source limit. Nothing was truncated or saved.');
  }
  const confirmedDecisions = validateConfirmedDecisions(input.confirmedDecisions);
  const user = JSON.stringify({
    title: input.title,
    useCase: { title: input.useCaseTitle, markdown: input.useCase },
    ...(confirmedDecisions?.length ? { confirmedDecisions } : {}),
  });
  signal?.throwIfAborted();
  const raw = await withAiStage('workforce-specification', () => getFoundryClient('use-case-spec').chatBulk([
    { role: 'system', content: WORKFORCE_SPECIFICATION_SYSTEM },
    { role: 'user', content: user },
  ], 24_000, 270_000, 'medium', {
    name: 'imagine_workforce_specification',
    schema: WORKFORCE_SPECIFICATION_RESPONSE_SCHEMA,
  }, signal, { requireDedicatedRoute: true }));
  signal?.throwIfAborted();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new ValidationError('The workforce specification response is not valid JSON. No document was saved.');
  }
  return renderWorkforceSpecification(parsed, input);
}
