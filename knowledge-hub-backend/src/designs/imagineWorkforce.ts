import { ValidationError } from '../types/errors.js';
import type { DesignSource } from './designArtifacts.js';

const KINDS = ['orchestrator', 'agent', 'human', 'rules', 'system', 'channel'] as const;
const MEMBER_FIELDS = {
  name: 'Name', purpose: 'Purpose', inputs: 'Inputs and grounding', outputs: 'Outputs and consumers',
  tools: 'Tools and dependencies', ownership: 'Ownership', authority: 'Authority and permissions',
  escalation: 'Escalation', governance: 'Governance', observability: 'Observability',
  evaluation: 'Evaluation', fidelity: 'Proposed execution fidelity', evidence: 'Specification evidence',
} as const;
type MemberField = keyof typeof MEMBER_FIELDS;
export interface WorkforceMember extends Record<MemberField, string> {
  id: string; kind: typeof KINDS[number]; realAgentId: string | null;
}
export interface WorkforceStage {
  id: string; mode: 'journey' | 'parallel'; members: string[]; entry: string; exit: string; failure: string;
}
export interface WorkforceHandoff {
  id: string; from: string; to: string; payload: string; trigger: string; mechanism: string;
  acceptance: string; recovery: string; protection: string;
}
export interface ImagineWorkforce {
  scope: string; members: WorkforceMember[]; stages: WorkforceStage[]; handoffs: WorkforceHandoff[]; prerequisites: string[];
}
const fail = (message: string): never => { throw new ValidationError(`Workforce validation: ${message}`); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('expected a structured object.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || /[\r\n]/.test(value)
    || /^(?:tbd|todo|not discussed|to be (?:defined|confirmed))\.?$/i.test(value.trim())) return fail(`${label} needs concrete single-line content (maximum 4,000 characters).`);
  return value.trim();
};
const id = (value: unknown): string => {
  const result = text(value, 'ID');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(result)) return fail('IDs must be stable lower-case identifiers, at most 64 characters.');
  return result;
};
function list<T>(value: unknown, label: string, minimum: number, maximum: number, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return fail(`${label} requires ${minimum}-${maximum} entries.`);
  return value.map(parse);
}
function unique(items: Array<{ id: string }>, label: string): void {
  if (new Set(items.map(item => item.id)).size !== items.length) fail(`${label} contains duplicate IDs.`);
}

export function validateImagineWorkforce(value: unknown, sources: DesignSource[], previous?: ImagineWorkforce): ImagineWorkforce {
  const data = object(value);
  const spec = sources.find(source => source.role === 'spec');
  if (!spec) return fail('the approved specification is missing.');
  const members = list(data['members'], 'Members', 1, 30, value => {
    const row = object(value);
    const kind = KINDS.find(kind => kind === row['kind']);
    if (!kind) return fail('unknown member kind.');
    const realAgentId = row['realAgentId'];
    if (realAgentId !== null && (typeof realAgentId !== 'string' || !realAgentId.trim()
      || !spec.markdown.includes(realAgentId))) return fail('a runtime binding must be null or an exact supplied specification reference, never invented.');
    const member: WorkforceMember = {
      id: id(row['id']), kind, realAgentId,
      name: text(row['name'], 'Name'), purpose: text(row['purpose'], 'Purpose'),
      inputs: text(row['inputs'], 'Inputs'), outputs: text(row['outputs'], 'Outputs'),
      tools: text(row['tools'], 'Tools'), ownership: text(row['ownership'], 'Ownership'),
      authority: text(row['authority'], 'Authority'), escalation: text(row['escalation'], 'Escalation'),
      governance: text(row['governance'], 'Governance'), observability: text(row['observability'], 'Observability'),
      evaluation: text(row['evaluation'], 'Evaluation'), fidelity: text(row['fidelity'], 'Execution fidelity'),
      evidence: text(row['evidence'], 'Specification evidence'),
    };
    if (member.evidence.length < 20 || !spec.markdown.includes(member.evidence)) return fail(`member ${member.id} needs an exact, substantive quote from the approved specification.`);
    const prior = previous?.members.find(item => item.name.toLowerCase() === member.name.toLowerCase());
    if (prior && prior.id !== member.id) return fail(`preserve the existing ID ${prior.id} for ${member.name}.`);
    return member;
  });
  unique(members, 'Members');
  const memberIds = new Set(members.map(member => member.id));
  const stages = list(data['stages'], 'Journey stages', 1, 30, value => {
    const row = object(value);
    const mode = row['mode'];
    if (mode !== 'journey' && mode !== 'parallel') return fail('stage mode must be journey or parallel.');
    const stage: WorkforceStage = { id: id(row['id']), mode,
      members: list(row['members'], 'Stage members', 1, 30, id),
      entry: text(row['entry'], 'Entry'), exit: text(row['exit'], 'Exit'), failure: text(row['failure'], 'Failure') };
    if (new Set(stage.members).size !== stage.members.length || stage.members.some(member => !memberIds.has(member))) return fail(`stage ${stage.id} references an unknown or duplicate member.`);
    return stage;
  });
  unique(stages, 'Stages');
  if (members.some(member => !stages.some(stage => stage.members.includes(member.id)))) return fail('every member must participate in the journey.');
  const handoffs = list(data['handoffs'], 'Handoffs', members.length > 1 ? 1 : 0, 60, value => {
    const row = object(value);
    const handoff = { id: id(row['id']), from: id(row['from']), to: id(row['to']),
      payload: text(row['payload'], 'Payload'), trigger: text(row['trigger'], 'Trigger'),
      mechanism: text(row['mechanism'], 'Mechanism'), acceptance: text(row['acceptance'], 'Acceptance'),
      recovery: text(row['recovery'], 'Recovery'), protection: text(row['protection'], 'Protection') };
    if (!memberIds.has(handoff.from) || !memberIds.has(handoff.to) || handoff.from === handoff.to) return fail(`handoff ${handoff.id} needs two distinct known members.`);
    const prior = previous?.handoffs.find(item => item.from === handoff.from && item.to === handoff.to && item.trigger === handoff.trigger);
    if (prior && prior.id !== handoff.id) return fail(`preserve handoff ID ${prior.id}.`);
    return handoff;
  });
  unique(handoffs, 'Handoffs');
  if (members.length > 1 && members.some(member => !handoffs.some(handoff => handoff.from === member.id || handoff.to === member.id))) return fail('every member needs an explicit incoming or outgoing handoff.');
  return { scope: text(data['scope'], 'Scope'), members, stages, handoffs,
    prerequisites: list(data['prerequisites'], 'Prerequisites', 0, 30, value => text(value, 'Prerequisite')) };
}

const string = { type: 'string' };
const array = (items: object) => ({ type: 'array', items });
const shape = (properties: Record<string, object>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
export const WORKFORCE_SCHEMA = { name: 'imagine_workforce', schema: shape({
  scope: string,
  members: array(shape({ id: string, kind: { type: 'string', enum: [...KINDS] }, realAgentId: { type: ['string', 'null'] },
    ...Object.fromEntries(Object.keys(MEMBER_FIELDS).map(key => [key, string])) })),
  stages: array(shape({ id: string, mode: { type: 'string', enum: ['journey', 'parallel'] }, members: array(string), entry: string, exit: string, failure: string })),
  handoffs: array(shape(Object.fromEntries(['id', 'from', 'to', 'payload', 'trigger', 'mechanism', 'acceptance', 'recovery', 'protection'].map(key => [key, string])))),
  prerequisites: array(string),
}) };

const cell = (value: string): string => value.replace(/\|/g, '\\|');
const quote = (value: string): string => {
  const delimiter = '`'.repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length)) + 1);
  return `${delimiter} ${value} ${delimiter}`;
};
function table(headers: string[], rows: string[][]): string {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}
export function renderImagineWorkforce(data: ImagineWorkforce): string {
  return ['# Imagine Agent Workforce Design',
    'Proposed design only. Catalogue visibility, runtime bindings, deployment and successful invocation are separate acceptance gates. None is claimed here.',
    '## Scope', data.scope, '## Members',
    ...data.members.map(member => [`### ${member.id}`, `- Kind: ${member.kind}`,
      `- Real agent ID: ${member.realAgentId ?? 'Unbound (design only)'}`,
      ...Object.entries(MEMBER_FIELDS).map(([field, label]) =>
        `- ${label}: ${field === 'evidence' ? quote(member.evidence) : member[field as MemberField]}`)].join('\n')),
    '## Journey', table(['ID', 'Mode', 'Members', 'Entry', 'Exit', 'Failure'], data.stages.map(stage =>
      [stage.id, stage.mode, stage.members.join(', '), stage.entry, stage.exit, stage.failure])),
    '## Handoffs', table(['ID', 'From', 'To', 'Payload', 'Trigger', 'Mechanism', 'Acceptance', 'Recovery', 'Protection'],
      data.handoffs.map(handoff => [handoff.id, handoff.from, handoff.to, handoff.payload, handoff.trigger, handoff.mechanism, handoff.acceptance, handoff.recovery, handoff.protection])),
    '## Decisions and execution prerequisites', data.prerequisites.length ? data.prerequisites.map(value => `- ${value}`).join('\n')
      : 'No additional prerequisites identified; this is not execution approval.',
  ].join('\n\n');
}

export function parseImagineWorkforce(markdown: string, sources: DesignSource[], blocks?: unknown[]): ImagineWorkforce {
  const section = (heading: string): string => {
    const parts = markdown.split(`## ${heading}\n`);
    if (parts.length !== 2) return fail(`expected one ${heading} section.`);
    return parts[1]!.split(/\n## /)[0]!.trim();
  };
  const members = section('Members').split(/^### /m).filter(part => part.trim()).map(part => {
    const lines = part.split('\n');
    const fields = Object.fromEntries(lines.slice(1).flatMap(line => {
      const match = /^[-*+]\s+([^:]+):\s*(.*)$/.exec(line);
      return match ? [[match[1]!, match[2]!]] : [];
    }));
    return { id: lines[0]?.trim(), kind: fields['Kind'],
      realAgentId: fields['Real agent ID'] === 'Unbound (design only)' ? null : fields['Real agent ID'],
      ...Object.fromEntries(Object.entries(MEMBER_FIELDS).map(([field, label]) => {
        const value = fields[label];
        const quoted = field === 'evidence' && value ? /^(`+)\s([\s\S]*?)\s\1$/.exec(value) : null;
        const compact = field === 'evidence' && value ? /^(`+)([\s\S]*?)\1$/.exec(value) : null;
        return [field, quoted?.[2] ?? compact?.[2] ?? value];
      })) };
  });
  const rows = (heading: string, headers: string[]): string[][] => {
    section(heading);
    let result: string[][];
    if (blocks) {
      const tables: string[][][] = [];
      const inline = (value: unknown): string => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map(inline).join('');
        const entry = object(value);
        if (typeof entry['text'] === 'string') return entry['text'];
        if (Array.isArray(entry['content'])) return inline(entry['content']);
        return fail('a table cell contains unsupported content; preserve its text before checking.');
      };
      const visit = (items: unknown[]): void => {
        for (const item of items) {
          const block = object(item);
          if (block['type'] === 'table') {
            const content = object(block['content']);
            if (!Array.isArray(content['rows'])) return fail('a native table has no rows.');
            tables.push(content['rows'].map(value => {
              const row = object(value);
              if (!Array.isArray(row['cells'])) return fail('a native table row has no cells.');
              return row['cells'].map(value => inline(value).trim());
            }));
          }
          if (Array.isArray(block['children'])) visit(block['children']);
        }
      };
      visit(blocks);
      const matches = tables.filter(table => table[0]?.join('\0') === headers.join('\0'));
      if (matches.length !== 1) return fail(`expected one native ${heading} table with its original headers.`);
      result = matches[0]!.slice(1);
    } else {
      result = section(heading).split('\n').filter(line => line.trim().startsWith('|'))
        .slice(2).map(line => line.trim().slice(1, -1).split(/(?<!\\)\|/)
          .map(value => value.trim().replace(/\\\|/g, '|').replace(/&#124;/g, '|')));
    }
    if (result.some(row => row.length !== headers.length)) return fail(`${heading} has an invalid table width; no handoff fields may be shifted or omitted.`);
    return result;
  };
  const stages = rows('Journey', ['ID', 'Mode', 'Members', 'Entry', 'Exit', 'Failure'])
    .map(([id, mode, members, entry, exit, failure]) => ({ id, mode, members: members?.split(/,\s*/), entry, exit, failure }));
  const handoffs = rows('Handoffs', ['ID', 'From', 'To', 'Payload', 'Trigger', 'Mechanism', 'Acceptance', 'Recovery', 'Protection'])
    .map(([id, from, to, payload, trigger, mechanism, acceptance, recovery, protection]) =>
    ({ id, from, to, payload, trigger, mechanism, acceptance, recovery, protection }));
  const prerequisites = section('Decisions and execution prerequisites').split('\n')
    .flatMap(line => /^[-*+]\s+(.*)$/.exec(line)?.[1] ?? []);
  return validateImagineWorkforce({ scope: section('Scope'), members, stages, handoffs, prerequisites }, sources);
}
