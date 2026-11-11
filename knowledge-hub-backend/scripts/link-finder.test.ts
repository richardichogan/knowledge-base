import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classify, extractLinks, guardArgumentLinks, guardLinks, linkBlockedMessage, linkFixNote, REMOVED_LINK, toolEvidence,
  type LinkCandidate, type LinkCheck, type LinkFinderDeps,
} from '../src/ai/linkFinder.js';

// The two invented links from the Frontier advanced specialisation email, and the real pages.
const BAD_LEARN = 'https://learn.microsoft.com/en-us/partner-center/membership/learn-profile-linking';
const BAD_SKILLING = 'https://partner.microsoft.com/en-us/partnership/partner-skilling-hub';
const GOOD_LEARN = 'https://learn.microsoft.com/en-us/partner-center/membership/ms-learn-associate';
const GOOD_SKILLING = 'https://www.skilling-hub.com/';
const GOOD_OTHER = 'https://github.com/features/copilot';

function deps(broken: Set<string>, found: Record<string, LinkCandidate[]> = {}, chosen: Record<string, string> = {}, walled = new Set<string>()): Partial<LinkFinderDeps> {
  return {
    check: async (url): Promise<LinkCheck> => broken.has(url)
      ? { url, status: 'broken', reason: 'the page says "404 - Page Not Found"' }
      : walled.has(url) ? { url, status: 'unverified', reason: 'the site would not let me open it to check (HTTP 403)' }
      : { url, status: 'ok', reason: 'the page opened', title: `Title of ${url}` },
    search: async target => found[target.url] ?? [],
    choose: async (target, candidates) => candidates.find(c => c.url === chosen[target.url])?.url ?? null,
  };
}

test('classify recognises the incident pages: soft 404 redirects are broken, sign-in walls are not', () => {
  assert.equal(classify(BAD_LEARN, 200, 'https://learn.microsoft.com/en-US/notfound', '404 - Page Not Found').status, 'broken');
  assert.equal(classify(BAD_SKILLING, 200, 'https://partner.microsoft.com/notfound?item=x', '').status, 'broken');
  assert.equal(classify('https://www.microsoft.com/x', 200, 'https://www.microsoft.com/x', 'Page cannot be found').status, 'broken');
  assert.equal(classify('https://partner.microsoft.com/dashboard/v2/membership/workspace', 200,
    'https://login.microsoftonline.com/common/oauth2/authorize', 'Sign in to your account').status, 'ok');
  assert.equal(classify(GOOD_OTHER, 404, GOOD_OTHER, '').status, 'broken');
  // A bot wall proves nothing: partner.microsoft.com showed the invented links as 403 "Access Denied" to a plain checker.
  assert.equal(classify(BAD_LEARN, 403, BAD_LEARN, 'Access Denied').status, 'unverified');
  assert.equal(classify('https://example.com/404-guide', 200, 'https://example.com/404-guide', 'A guide').status, 'ok');
  assert.equal(classify(GOOD_OTHER, 502, GOOD_OTHER, '').status, 'unreachable');
});

test('extractLinks finds markdown, bare and punctuated links with their labels', () => {
  const links = extractLinks(`Link your profile [here](${BAD_LEARN}).\nThen visit ${GOOD_SKILLING}, and (see ${GOOD_OTHER}).`);
  assert.deepEqual(links.map(link => link.url), [BAD_LEARN, GOOD_SKILLING, GOOD_OTHER]);
  assert.equal(links[0]?.label, 'here');
  assert.match(links[0]?.context ?? '', /Link your profile/);
});

test('a link alone under "Reference:" carries the explanation above it, and the note quotes no live address', () => {
  // The Slack draft put the invented Skilling Hub link on its own line, so its line alone said nothing.
  const slack = `Please link your Skilling Hub account in Partner Center.\n\nTo do this:\n1. Select the Skilling Hub tab\n2. Sign in with your Skilling Hub account\n\nReference:\n\`${BAD_SKILLING}\`\n\nThanks`;
  const [link] = extractLinks(slack);
  assert.equal(link?.url, BAD_SKILLING);
  assert.match(link?.context ?? '', /link your Skilling Hub account in Partner Center/);
  assert.match(link?.context ?? '', /Sign in with your Skilling Hub account/);
  const note = linkFixNote([{ from: BAD_SKILLING, to: GOOD_LEARN, reason: 'it redirects to a "page not found" page (https://partner.microsoft.com/en-GB/notfound)' }]);
  assert.deepEqual(extractLinks(note).map(found => found.url), [GOOD_LEARN]);
});

test('guardLinks swaps invented links for verified pages and tells the user', async () => {
  const email = `1. Link your Learn profile: [Link your profile](${BAD_LEARN})\n2. Open the [Skilling Hub](${BAD_SKILLING}).\n3. Read ${GOOD_OTHER}`;
  const result = await guardLinks(email, { deps: deps(new Set([BAD_LEARN, BAD_SKILLING]),
    { [BAD_LEARN]: [{ url: GOOD_LEARN }, { url: BAD_SKILLING }], [BAD_SKILLING]: [{ url: GOOD_SKILLING }] },
    { [BAD_LEARN]: GOOD_LEARN, [BAD_SKILLING]: GOOD_SKILLING }) });
  assert.equal(result.checked, 3);
  assert.deepEqual(result.unresolved, []);
  assert.ok(!result.text.includes(BAD_LEARN) && !result.text.includes(BAD_SKILLING));
  assert.ok(result.text.includes(`[Link your profile](${GOOD_LEARN})`) && result.text.includes(`[Skilling Hub](${GOOD_SKILLING})`));
  assert.ok(result.text.includes(GOOD_OTHER));
  const note = linkFixNote(result.fixed);
  assert.match(note, /2 were broken/);
  // The note names the old address as text only, so it cannot be clicked or re-checked as a link.
  assert.ok(!note.includes(BAD_LEARN) && note.includes(BAD_LEARN.replace('https://', '')));
});

test('guardLinks never keeps a broken link: no verified replacement means unresolved', async () => {
  const result = await guardLinks(`Sign up at [the hub](${BAD_SKILLING}).`, { deps: deps(new Set([BAD_SKILLING, GOOD_LEARN]),
    { [BAD_SKILLING]: [{ url: GOOD_LEARN }] }, { [BAD_SKILLING]: GOOD_LEARN }) });
  assert.deepEqual(result.unresolved.map(p => p.url), [BAD_SKILLING]);
  assert.equal(result.fixed.length, 0);
  assert.ok(!linkBlockedMessage(result.unresolved).includes('https://'));
});

test('guardLinks rejects a model choice that was not a checked, working candidate', async () => {
  const result = await guardLinks(`See ${BAD_LEARN}`, { deps: { ...deps(new Set([BAD_LEARN]), { [BAD_LEARN]: [{ url: GOOD_LEARN }] }),
    choose: async () => 'https://learn.microsoft.com/invented-by-the-model' } });
  assert.deepEqual(result.unresolved.map(p => p.url), [BAD_LEARN]);
});

test('guardLinks leaves links the user supplied, and strips a broken link that is only being discussed', async () => {
  const userLink = await guardLinks(`You asked me to use ${BAD_LEARN}`, { userText: [`use ${BAD_LEARN} please`], deps: deps(new Set([BAD_LEARN])) });
  assert.equal(userLink.checked, 0);
  const apology = await guardLinks(`Sorry, the link ${BAD_SKILLING} was wrong.`, { deps: deps(new Set([BAD_SKILLING])) });
  assert.deepEqual(apology.unresolved, []);
  assert.equal(apology.text, `Sorry, the link ${REMOVED_LINK} was wrong.`);
});

test('guardArgumentLinks fixes links inside a save and leaves identifiers alone', async () => {
  const args = { noteId: 'abc', title: 'Email', content: `Go to [Learn](${BAD_LEARN})`, sections: [{ heading: 'x', markdown: `Hub: ${BAD_LEARN}` }] };
  const result = await guardArgumentLinks(args, { deps: deps(new Set([BAD_LEARN]), { [BAD_LEARN]: [{ url: GOOD_LEARN }] }, { [BAD_LEARN]: GOOD_LEARN }) });
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.args, { noteId: 'abc', title: 'Email', content: `Go to [Learn](${GOOD_LEARN})`, sections: [{ heading: 'x', markdown: `Hub: ${GOOD_LEARN}` }] });
  const none = await guardArgumentLinks({ content: 'No links here' }, { deps: deps(new Set()) });
  assert.equal(none.checked, 0);
});

test('a walled link passes only when a real source supplied it', async () => {
  const walled = 'https://www.linkedin.com/posts/real-post-123';
  const invented = 'https://www.linkedin.com/posts/invented-post-456';
  const text = `Read [my post](${walled}) and [the follow-up](${invented}).`;
  const result = await guardLinks(text, { evidenceText: [JSON.stringify({ results: [{ url: walled }] })],
    deps: deps(new Set(), {}, {}, new Set([walled, invented])) });
  assert.deepEqual(result.unresolved.map(p => p.url), [invented]);
});

test('toolEvidence ignores failed calls and the address a call was asked to open', () => {
  const messages = [
    { role: 'assistant', content: null, tool_calls: [
      { id: 'a', function: { arguments: JSON.stringify({ url: BAD_LEARN }) } },
      { id: 'b', function: { arguments: JSON.stringify({ url: BAD_SKILLING }) } },
      { id: 'c', function: { arguments: JSON.stringify({ query: 'learn profile' }) } },
    ] },
    { role: 'tool', tool_call_id: 'a', content: JSON.stringify({ error: 'fetch failed', url: BAD_LEARN }) },
    { role: 'tool', tool_call_id: 'b', content: JSON.stringify({ success: true, url: BAD_SKILLING, title: '404 - Page Not Found' }) },
    { role: 'tool', tool_call_id: 'c', content: JSON.stringify({ results: [{ url: GOOD_LEARN }] }) },
  ];
  const evidence = toolEvidence(messages).join('\n');
  assert.ok(!evidence.includes(BAD_LEARN) && !evidence.includes(BAD_SKILLING));
  assert.ok(evidence.includes(GOOD_LEARN));
});
