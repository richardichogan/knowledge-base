export interface PeopleQuery { query: string; start: number; end: number }
export function peopleQuery(input: string, cursor: number): PeopleQuery | null {
  const match = /(^|[\s(])@([\p{L}\p{N} .'-]{0,80})$/u.exec(input.slice(0, cursor));
  if (!match) return null;
  return { query: match[2]!.trim(), start: cursor - match[2]!.length - 1, end: cursor };
}
export function insertPersonMention(input: string, query: PeopleQuery, person: { id: string; name: string }): { input: string; cursor: number } {
  const token = `@[${person.name.replace(/[[\]\r\n]/g, '')}](/people?personId=${encodeURIComponent(person.id)}) `;
  return { input: input.slice(0, query.start) + token + input.slice(query.end), cursor: query.start + token.length };
}
