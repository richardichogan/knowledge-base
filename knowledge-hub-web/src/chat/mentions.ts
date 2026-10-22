export type ChatMentionType = 'person' | 'company' | 'project' | 'note' | 'document';
export interface ChatMentionTarget {
  type: ChatMentionType;
  id: string;
  title: string;
  href: string;
  detail: string;
}

export const CHAT_MENTION_LABELS: Record<ChatMentionType, string> = {
  person: 'Person', company: 'Company', project: 'Project', note: 'Think note', document: 'Library document',
};

export function insertChatMention(input: string, query: { start: number; end: number }, target: ChatMentionTarget): { input: string; cursor: number } {
  const token = `@[${target.title.replace(/[[\]\r\n]/g, '')}](${target.href}) `;
  return { input: input.slice(0, query.start) + token + input.slice(query.end), cursor: query.start + token.length };
}
