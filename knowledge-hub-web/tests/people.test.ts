import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePeopleReport } from '../src/people/importPeople';
import { insertPersonMention, peopleQuery } from '../src/people/chatMentions';
import { buildComposerIntent } from '../src/chat/composerIntent';
import { entityLinkHref, linkPlainMentions } from '../src/notes/entityLinks';

const report = `# Key contacts
**Period:** 1-14 October 2026
## 1. Core regular contacts (3+ direct emails)
| Name | Email | Organisation | Emails sent to them | Main threads |
|---|---|---|---|---|
| Example Person | First@example.com | Org A (your manager) | 4 | Roadmap |
| Example Person | second@example.org (also third@example.org) | Org B | 3 | Planning |
## 2. Regular contacts (2 direct emails)
| Name | Email | Organisation | Main threads |
|---|---|---|---|
| Second Contact | s@example.com | Org A | Research |
## 3. Two-way conversations (one email from you, plus replies from them)
| Name | Email | Organisation | Main thread |
|---|---|---|---|
| Third Contact | t@example.com | Org A | Intro |
`;
test('contact report preserves aliases, roles, provenance, threads and period-specific frequency', () => {
  const people = parsePeopleReport(report);
  assert.equal(people.length, 3);
  const person = people[0]!;
  assert.equal(person.name, 'Example Person');
  assert.deepEqual(person.emails, ['first@example.com', 'second@example.org', 'third@example.org']);
  assert.equal(person.organisation, 'Org A / Org B');
  assert.equal(person.role, 'your manager');
  assert.equal(person.threads, 'Roadmap\nPlanning');
  assert.equal(person.emailCount, 7);
  assert.equal(person.sourcePeriod, '1-14 October 2026');
  assert.equal(people[1]?.emailCount, 2);
  assert.equal(people[2]?.emailCount, 1);
  assert.throws(() => parsePeopleReport('No table'), /No contact tables/);
  assert.throws(() => parsePeopleReport(report.replace('First@example.com', 'broken')), /valid email/);
});

test('person mentions have stable links and do not consume project @mentions', () => {
  assert.equal(peopleQuery('a@example.com', 13), null);
  assert.equal(peopleQuery('hello @Ex', 9)?.query, 'Ex');
  assert.equal(peopleQuery('hello @Example Pe', 17)?.query, 'Example Pe');
  const query = peopleQuery('Ask @Ex tomorrow', 7)!;
  const inserted = insertPersonMention('Ask @Ex tomorrow', query, { id: 'stable-id', name: 'Example Person' });
  assert.equal(inserted.input, 'Ask @[Example Person](/people?personId=stable-id)  tomorrow');
  assert.equal(inserted.cursor, inserted.input.indexOf(' tomorrow'));
  const intent = buildComposerIntent({ input: `${inserted.input} @project`, projects: [{ id: 'p', name: 'Project' }], activeProjectId: '' });
  assert.equal(intent.explicitProjectId, 'p');
  assert.match(intent.rawText, /personId=stable-id/);
  assert.equal(entityLinkHref('person', 'a b'), '/people?personId=a%20b');
  const linked = linkPlainMentions([{ type: 'paragraph', content: [{ type: 'text', text: 'Example Person', styles: {} }] }],
    { type: 'person', id: 'stable-id', title: 'Example Person', href: '/people?personId=stable-id' });
  assert.equal(linked.count, 1);
  assert.match(JSON.stringify(linked.blocks), /"entityType":"person"/);
});
