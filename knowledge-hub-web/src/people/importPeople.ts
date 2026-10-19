import { EMPTY_PERSON, type PersonInput } from '../types/people';

/** Reads the contact tables in an email-contact Markdown report without inferring roles or relationships. */
export function parsePeopleReport(markdown: string): PersonInput[] {
  if (markdown.length > 500_000) throw new Error('The contact report must be smaller than 500 KB.');
  const source = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? 'Imported contact report';
  const sourcePeriod = /^\*\*Period:\*\*\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? '';
  const people = new Map<string, PersonInput>();
  let group = '';
  let columns: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) { group = line.replace(/^##\s+(?:\d+\.\s*)?/, '').trim(); columns = []; }
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    if (cells[0]?.toLowerCase() === 'name') { columns = cells.map(cell => cell.toLowerCase()); continue; }
    if (!columns.length || cells.every(cell => /^[-:\s]+$/.test(cell))) continue;
    if (cells.length !== columns.length) throw new Error('A contact row has a different number of columns from its table header.');
    const get = (label: string): string => cells[columns.indexOf(label)] ?? '';
    const name = get('name');
    const rawEmails = get('email');
    const emails = [...new Set((rawEmails.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])
      .map(email => email.toLowerCase()))];
    if (!name || !emails.length) throw new Error(`A contact row has no name or valid email: ${name || rawEmails}`);
    const org = get('organisation');
    const role = /\(([^)]+)\)/.exec(org)?.[1] ?? '';
    const countText = get('emails sent to them');
    const count = countText ? Number(countText) : /^Regular contacts \(2/.test(group) ? 2 : /^Two-way conversations/.test(group) ? 1 : null;
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new Error(`Invalid email count for ${name}`);
    const contact: PersonInput = {
      ...EMPTY_PERSON, name, emails, organisation: org.replace(/\s*\([^)]*\)/g, '').trim(), role,
      threads: get('main threads') || get('main thread'), source, sourcePeriod, contactGroup: group, emailCount: count,
    };
    const key = name.toLocaleLowerCase();
    const previous = people.get(key);
    if (previous) {
      contact.emails = [...new Set([...previous.emails, ...contact.emails])];
      contact.organisation = [...new Set([...previous.organisation.split(' / '), ...contact.organisation.split(' / ')])].join(' / ');
      contact.threads = [...new Set([previous.threads, contact.threads].filter(Boolean))].join('\n');
      contact.role = previous.role || contact.role;
      contact.emailCount = previous.emailCount !== null && contact.emailCount !== null ? previous.emailCount + contact.emailCount : null;
    }
    people.set(key, contact);
  }
  if (!people.size) throw new Error('No contact tables found. Use a Markdown table with Name, Email and Organisation columns.');
  if (people.size > 500) throw new Error('Import at most 500 people at once.');
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}
