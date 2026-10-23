import type { LlmToolDefinition } from './foundryClient.js';
import { DEMO_SPECIFICATION_TEMPLATE } from './demoSpecificationTemplate.js';

export const DEMO_SPECIFICATION_VERSION = 'imagine-demo-specification-v1';
export const DEMO_SPECIFICATION_WRITE_TOOL = 'create_demo_specification';
const MAX_FIELD_CHARS = 4000;
const MAX_ADDITIONAL_ROWS = 100;
const MAX_SPECIFICATION_CHARS = 180_000;

interface Field {
  id: string;
  section: string;
  label: string;
  line: number;
  cell?: number;
}
interface Table {
  id: string;
  section: string;
  headers: string[];
  lastLine: number;
}
const lines = DEMO_SPECIFICATION_TEMPLATE.trimEnd().split('\n');
const fields: Field[] = [];
const tables: Table[] = [];
let section = '';
let currentTable: Table | undefined;
for (const [line, text] of lines.entries()) {
  if (text.startsWith('## ')) section = text.slice('## '.length);
  if (/^- .+:$/.test(text)) {
    fields.push({ id: `field-${fields.length + 1}`, section, label: text.slice('- '.length, -1), line });
  }
  if (!text.startsWith('|')) { currentTable = undefined; continue; }
  const cells = text.slice(1, -1).split('|').map(cell => cell.trim());
  if (!currentTable) {
    currentTable = { id: `table-${tables.length + 1}`, section, headers: cells, lastLine: line };
    tables.push(currentTable);
    continue;
  }
  currentTable.lastLine = line;
  if (cells.every(cell => /^:?-+:?$/.test(cell))) continue;
  for (const [cell, value] of cells.entries()) {
    if (value === '' || /^<[^>]+>$/.test(value)
      || ['Unresolved', 'Not recorded', 'Agent derives exact identities', 'live / approved simulation / not integrated', 'Not authorized until supplied'].includes(value)) {
      fields.push({
        id: `field-${fields.length + 1}`, section,
        label: `${currentTable.id}, row "${cells[0] || 'Unresolved'}", ${currentTable.headers[cell]}`,
        line, cell,
      });
    }
  }
}

export const DEMO_SPECIFICATION_INSTRUCTIONS = [
  'Create an IMAGINE demo specification from the source Think note and confirmed decisions in this conversation.',
  'First call get_demo_specification_template. Read the FULL source note with read_knowledge_record, following chunk/continuation results until complete; do not fetch a note as a web page.',
  'Supply every field ID to create_demo_specification. The server retains all ten sections, fixed requirements, tables, G0-G7 criteria and the unchanged Build instruction.',
  'Use additionalRows for every further actor, workforce member, dependency, channel, requirement and scenario needed. Cover each original promise in traceability.',
  'Use facts from the source and chat. Clearly label proposed technical detail; never invent identities, policies, approvals, percentages, measurements, receipts or accepted gates.',
  'For missing facts use "Unresolved - owner not assigned; blocks <specific requirement>; resolve by <decision/evidence>". Use a known owner only when actually supplied.',
  'For unavailable evidence use "Not recorded - blocks <criterion>". Live authorization remains "Not authorized until supplied" without an actual approval reference.',
  'The referenced repository operating/construction/acceptance guides are not supplied by this template. Read them only if available in the authorised sources; otherwise record their unavailable status and affected blockers.',
  'An optional sectionDetails entry for each numbered section supplies its demo-specific narrative; it does not replace mandatory fields or tables.',
  'Save a new Think note only, preserving the source. Do not execute the embedded Build instruction, deploy, send messages, grant access, push to GitHub or claim acceptance.',
  'On a validation error, repair the reported fields and retry; never fall back to an incomplete generic note. Confirm creation only after success.',
].join('\n');

export function isDemoSpecificationRequest(message: string): boolean {
  const request = message.split('--- BEGIN USE CASE SOURCE ---')[0] ?? '';
  return /\b(?:imagine\s+)?demo\s+spec(?:ification)?\b/i.test(request)
    && /\b(?:create|generate|draft|write|save|prepare|produce)\b/i.test(request);
}

export const DEMO_SPECIFICATION_TOOLS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_demo_specification_template',
      description: 'Reads the mandatory versioned IMAGINE demo specification template and exact field IDs. Use before creating a demo specification from a chat and Think note. Not the shorter generic use-case/demo brief.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: DEMO_SPECIFICATION_WRITE_TOOL,
      description: 'Creates a NEW Think demo specification from the exact versioned template, source note and this chat. Rejects missing/blank fields; never changes the original note. Get the template/field IDs first. Unknown facts must be explicit unresolved blockers, not invented evidence.',
      parameters: {
        type: 'object',
        properties: {
          templateVersion: { type: 'string', enum: [DEMO_SPECIFICATION_VERSION] },
          name: { type: 'string', description: 'Demo name, or Unresolved with the needed decision.' },
          sourceNoteId: { type: 'string', description: 'Actual Think note UUID read from context or knowledge tools.' },
          values: {
            type: 'object',
            description: 'Every field ID from get_demo_specification_template mapped to its nonempty single-line answer. No field may be omitted. Use explicit unresolved blockers when facts are missing.',
            additionalProperties: { type: 'string' },
          },
          additionalRows: {
            type: 'object',
            description: 'Optional table ID to extra rows. Each row must contain one nonempty single-line string per header, including explicit unresolved values.',
            additionalProperties: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          },
          sectionDetails: {
            type: 'object',
            description: 'Optional numbered section (1-10) to demo-specific narrative, clearly separating known facts, proposals and blockers. One line per section.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['templateVersion', 'name', 'sourceNoteId', 'values'],
      },
    },
  },
];

export function demoSpecificationForm(): unknown {
  return {
    templateVersion: DEMO_SPECIFICATION_VERSION,
    instructions: DEMO_SPECIFICATION_INSTRUCTIONS,
    fields: fields.map(({ id, section: fieldSection, label }) => ({ id, section: fieldSection, label })),
    tables: tables.map(({ id, section: tableSection, headers }) => ({ id, section: tableSection, headers })),
    templateMarkdown: DEMO_SPECIFICATION_TEMPLATE,
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
function answer(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value) || value.length > MAX_FIELD_CHARS
    || /^<[^>]+>$/.test(value.trim())) {
    throw new Error(`${label} requires a nonempty single-line answer (maximum 4000 characters), or an explicit unresolved blocker.`);
  }
  return value.trim();
}
function tableRow(cells: string[]): string {
  return `| ${cells.map(cell => cell.replace(/\|/g, '&#124;')).join(' | ')} |`;
}

/** Rendering the immutable structure server-side makes omissions impossible on this save path. */
export function renderDemoSpecification(
  input: Record<string, unknown>,
  sources: { noteUrl: string; chatUrl: string },
): { title: string; markdown: string } {
  if (input['templateVersion'] !== DEMO_SPECIFICATION_VERSION) throw new Error('Read the current demo specification template before saving.');
  const name = answer(input['name'], 'Demo name');
  const values = record(input['values'], 'values');
  const known = new Set(fields.map(field => field.id));
  const missing = fields.filter(field => !(field.id in values)).map(field => field.id);
  const unknown = Object.keys(values).filter(id => !known.has(id));
  if (missing.length || unknown.length) throw new Error(`Invalid demo specification fields. Missing: ${missing.join(', ') || 'none'}. Unknown: ${unknown.join(', ') || 'none'}.`);
  const output = [...lines];
  output[0] = `# IMAGINE demo specification: ${name}`;
  for (const field of fields) {
    const value = answer(values[field.id], `${field.id} (${field.label})`);
    if (field.cell === undefined) output[field.line] = `${lines[field.line]} ${value}`;
    else {
      const cells = output[field.line]!.slice(1, -1).split('|').map(cell => cell.trim());
      cells[field.cell] = value;
      output[field.line] = tableRow(cells);
    }
  }
  const extra = input['additionalRows'] === undefined ? {} : record(input['additionalRows'], 'additionalRows');
  for (const id of Object.keys(extra)) if (!tables.some(table => table.id === id)) throw new Error(`Unknown table: ${id}.`);
  const additions = new Map<number, string[]>();
  for (const table of tables) {
    const rows = extra[table.id];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > MAX_ADDITIONAL_ROWS) throw new Error(`${table.id} requires at most ${MAX_ADDITIONAL_ROWS} additional rows.`);
    additions.set(table.lastLine, rows.map((row, index) => {
      if (!Array.isArray(row) || row.length !== table.headers.length) throw new Error(`${table.id} row ${index + 1} requires ${table.headers.length} cells.`);
      return tableRow(row.map((cell, column) => answer(cell, `${table.id} row ${index + 1}, ${table.headers[column]}`)));
    }));
  }
  const details = input['sectionDetails'] === undefined ? {} : record(input['sectionDetails'], 'sectionDetails');
  for (const key of Object.keys(details)) if (!/^(?:[1-9]|10)$/.test(key)) throw new Error(`Unknown section: ${key}.`);
  const rendered: string[] = [];
  for (const [index, line] of output.entries()) {
    if (line === '## Build instruction') rendered.push(
      '## Draft provenance',
      '',
      `Template: ${DEMO_SPECIFICATION_VERSION}. Source Think note: ${sources.noteUrl}. Source conversation: ${sources.chatUrl}.`,
      'This generated draft is not approval, implementation evidence or authorization. Referenced repository methods require separate source verification.',
      '',
    );
    rendered.push(line, ...(additions.get(index) ?? []));
    const sectionNumber = /^## (\d+)\./.exec(line)?.[1];
    if (sectionNumber && details[sectionNumber] !== undefined) rendered.push('', `**Demo-specific detail:** ${answer(details[sectionNumber], `Section ${sectionNumber}`)}`);
  }
  const markdown = `${rendered.join('\n')}\n`;
  if (markdown.length > MAX_SPECIFICATION_CHARS) throw new Error(`Demo specification exceeds ${MAX_SPECIFICATION_CHARS} characters. Shorten field answers without omitting fields.`);
  return { title: `Demo spec: ${name}`, markdown };
}
