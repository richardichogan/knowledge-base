import { createHash } from 'node:crypto';

const DATE_CHARS = 10;
const YEAR_CHARS = 4;
const MONTH_ABBREVIATION_CHARS = 3;
const CLOCK_FIELD_CHARS = 2;
const LAST_HOUR = 23;
const MS_PER_HOUR = 3_600_000;

export interface DailyTask {
  key: string;
  title: string;
  project: string;
  owner: string;
  due: string | null;
  dueText: string;
  source: string;
}
export interface DailyMeeting { start: string; end: string; title: string; flag: string }
export interface DailyInsights {
  date: string;
  knowledgeDate: string;
  knowledge: string;
  tasks: DailyTask[];
  meetings: DailyMeeting[];
  warnings: string[];
}

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function normaliseIdentity(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function validDate(text: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T12:00:00Z`).toISOString().slice(0, DATE_CHARS) === text ? text : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function explicitDate(text: string, year?: string): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/.exec(text.trim());
  if (iso !== null) return validDate(iso[0]);
  const match = /^(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?$/.exec(text.trim());
  if (match === null) return null;
  const [, day = '', monthName = '', explicitYear] = match;
  const month = MONTHS.indexOf(monthName.slice(0, MONTH_ABBREVIATION_CHARS).toLowerCase());
  const y = explicitYear ?? year;
  return month < 0 || y === undefined ? null : validDate(`${y}-${String(month + 1).padStart(CLOCK_FIELD_CHARS, '0')}-${day.padStart(CLOCK_FIELD_CHARS, '0')}`);
}

/** Only unambiguous calendar dates become deadlines; all other wording stays in the task body. */
export function parseDailyInsights(filename: string, text: string): DailyInsights {
  // Markdown presentation is not a contract: retain explicit facts, discard decoration.
  text = text.replace(/\r\n/g, '\n').replace(/^\s*>\s?/gm, '')
    .replace(/\*\*|__/g, '').replace(/^\s*[-*+]\s+(?=(?:Task|Title|Project|Owner|Due|Source)\s*:)/gmi, '')
    .replace(/^\s*\d+[.)]\s+(?=(?:Task|Title)\s*:)/gmi, '');
  const fileDate = /^Daily-Briefing-(\d{4}-\d{2}-\d{2})\.md$/i.exec(filename)?.[1];
  if (fileDate === undefined || validDate(fileDate) === null) throw new Error('Expected Daily-Briefing-YYYY-MM-DD.md');
  const header = /^#{1,6}\s+Morning briefing\s*[:\u2013\u2014-]\s*(?:\w+,\s*)?(.+)$/mi.exec(text)?.[1];
  if (header === undefined || explicitDate(header) !== fileDate) throw new Error('Briefing heading date must match its filename');
  const part2 = /^#{1,6}\s+Part 2\s*[:\u2013\u2014-]\s*Yesterday[^\n]*$/mi.exec(text);
  if (part2 === null) throw new Error('Missing Part 2: Yesterday knowledge section');
  const previous = new Date(`${fileDate}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const knowledgeDate = previous.toISOString().slice(0, DATE_CHARS);
  const label = /\(\w+,\s*(\d{1,2}\s+[A-Za-z]+(?:\s+\d{4})?)\)/.exec(part2[0])?.[1];
  if (label === undefined || explicitDate(label, knowledgeDate.slice(0, YEAR_CHARS)) !== knowledgeDate) {
    throw new Error("Yesterday's heading must explicitly identify the previous calendar day");
  }
  const warnings: string[] = [];
  const tasks: DailyTask[] = [];
  // Split at the next task/section rather than guessing actions from narrative prose.
  let taskText = text.replace(/\s+[\u00b7\u2022]\s+(?=(?:Project|Owner|Due|Source)\s*:)/gi, '\n');
  // Also accept explicitly labelled task tables; column order is immaterial.
  const lines = taskText.split('\n');
  for (let index = 0; index < lines.length - 1; index++) {
    const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(value => value.replace(/\\\|/g, '|').trim());
    if (!/^\s*\|/.test(lines[index] ?? '')) continue;
    const columns = cells(lines[index] ?? '').map(value => value.toLowerCase());
    const titleColumn = columns.findIndex(value => value === 'task' || value === 'title');
    if (titleColumn < 0 || !['project', 'owner', 'due', 'source'].every(value => columns.includes(value))) continue;
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] ?? '')) continue;
    for (index += 2; index < lines.length && /^\s*\|/.test(lines[index] ?? ''); index++) {
      const values = cells(lines[index] ?? '');
      taskText += `\nTask: ${values[titleColumn] ?? ''}\n${['Project', 'Owner', 'Due', 'Source'].map(name => `${name}: ${values[columns.indexOf(name.toLowerCase())] ?? ''}`).join('\n')}\n---\n`;
    }
  }
  const blocks = taskText.split(/(?=^(?:Task|Title)\s*:)/mi).slice(1);
  for (const block of blocks) {
    const title = /^(?:Task|Title)\s*:\s*(.+)$/mi.exec(block)?.[1]?.trim();
    if (!title) continue;
    const fields = block.split(/^#{1,6} |^---/m)[0] ?? '';
    const field = (name: string): string => new RegExp(`^(?:-\\s*)?${name}\\s*:\\s*(.+)$`, 'mi').exec(fields)?.[1]?.trim() ?? '';
    const project = field('Project');
    const owner = field('Owner');
    const dueText = field('Due');
    const source = field('Source');
    if (!project || !owner || !dueText || !source) throw new Error(`Incomplete task: ${title}`);
    const owners = owner.split(/,|\s+and\s+/i).map(value => value.trim());
    if (!owners.some(value => /^(richard hogan|richard|me)(?:\s+\(with [^)]+\))?$/i.test(value))) {
      warnings.push(`Not assigned to Richard: ${title} (${owner})`);
      continue;
    }
    const due = explicitDate(dueText);
    if (due === null && !/^not stated$/i.test(dueText)) warnings.push(`Deadline needs review: ${title} — ${dueText}`);
    tasks.push({ key: digest([project, 'Richard Hogan', title].map(normaliseIdentity).join('|')), title, project, owner, due, dueText, source });
  }
  const today = text.slice(0, part2.index);
  const meetingSection = /^#{1,6}\s+(?:(?:\([a-z]\)|[a-z][.)])\s+)?Today['\u2019]s meetings\s*\n([\s\S]*?)(?=^#{1,6} |$(?![\s\S]))/mi.exec(today)?.[1];
  if (meetingSection === undefined) throw new Error("Missing Today's meetings table");
  const meetings: DailyMeeting[] = [];
  for (const line of meetingSection.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
    if (/^(Time(?:\s+\(UK\))?|[-:\s]+)$/i.test(cells[0] ?? '')) continue;
    const [timeCell = '', title = '', ...details] = cells;
    const flag = details.filter(Boolean).join(' · ');
    if (/^All day$/i.test(timeCell) && title) {
      warnings.push(`All-day calendar entry needs review: ${title}`);
      continue;
    }
    const times = /^([0-2]\d:[0-5]\d)\s*[\u2013\u2014-]\s*([0-2]\d:[0-5]\d)$/.exec(timeCell);
    if (times === null || !title) {
      throw new Error(`Unrecognised meeting row: ${line}`);
    }
    const [, start = '', end = ''] = times;
    if (Number(start.slice(0, CLOCK_FIELD_CHARS)) > LAST_HOUR || Number(end.slice(0, CLOCK_FIELD_CHARS)) > LAST_HOUR) {
      throw new Error(`Unrecognised meeting row: ${line}`);
    }
    if (/^\*?Free:/i.test(title)) continue;
    if (end <= start) throw new Error(`Meeting end must follow start: ${title}`);
    meetings.push({ start, end, title, flag });
  }
  return { date: fileDate, knowledgeDate, knowledge: text.slice(part2.index).trim(), tasks, meetings, warnings };
}

export function londonTime(date: string, time: string): string {
  const naive = new Date(`${date}T${time}:00Z`);
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' })
    .formatToParts(naive).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
  const offset = Number(/GMT([+-]\d+)?/.exec(zone)?.[1] ?? 0);
  return new Date(naive.getTime() - offset * MS_PER_HOUR).toISOString();
}
