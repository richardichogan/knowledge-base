import { EMPTY_PERSON, type PersonInput } from '../types/people';

const EMAIL = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Finds explicit addresses only; names, organisations and relationships remain for review. */
export function contactsFromText(text: string): PersonInput[] {
  if (text.length > 10_000) throw new Error('Use at most 10,000 characters to identify contacts.');
  const emails = [...new Set((text.match(EMAIL) ?? []).map(email => email.toLowerCase()))];
  if (emails.length > 20) throw new Error('Review at most 20 contacts at once.');
  return (emails.length ? emails : ['']).map(email => {
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namedAddress = email ? new RegExp(`(?:^|[\\n,;])\\s*"?([\\p{L}][\\p{L}\\p{M}.'’ -]{1,198})"?\\s*<${escaped}>`, 'iu').exec(text)?.[1]?.trim() : undefined;
    const labelledName = emails.length === 1 ? /^(?:Name|Contact):\s*([^\r\n]{1,200})$/mi.exec(text)?.[1]?.trim() : undefined;
    return { ...EMPTY_PERSON, emails: email ? [email] : [], source: 'Identified from selected text',
      notes: text, name: namedAddress ?? labelledName ?? '' };
  });
}

export function recipientMention(value: string): { start: number; query: string } | null {
  const match = /(?:^|[,;\n])\s*@([^,;\n]*)$/.exec(value);
  return match ? { start: value.lastIndexOf('@'), query: match[1] ?? '' } : null;
}

export function insertRecipient(value: string, email: string): string {
  const mention = recipientMention(value);
  return `${mention ? value.slice(0, mention.start) : value.trim() ? `${value.trim().replace(/[,;]$/, '')}, ` : ''}${email}, `;
}
