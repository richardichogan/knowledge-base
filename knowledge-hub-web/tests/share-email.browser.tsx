import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@carbon/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ShareEmailSettings } from '../src/components/ShareEmailSettings';
import { ShareEmailModal } from '../src/components/ShareEmailModal';
import { api } from '../src/services/api';
import type { ShareEmailContent, ShareEmailInput, ShareEmailStatus } from '../src/types/shareEmail';
import '../src/styles/global.scss';

const status: ShareEmailStatus = { configured: false, from: 'share@athena.themicrosoftcloudblog.com',
  username: 'athena.themicrosoftcloudblog.com', replyTo: '', host: 'mail-eu.smtp2go.com', port: 2525 };
let failSettings = true;
let saves = 0;
let verifies = 0;
let smtpSubmissions = 0;
let invalidNext = true;
let releaseSend: () => void = () => undefined;
const attempts: ShareEmailInput[] = [];
let contactSaves = 0;
api.getPeople = async () => ({ success: true, data: [{ id: 'contact-1', name: 'Example Contact',
  emails: ['person@example.com'], organisation: 'Example Org', role: '', notes: '', threads: '',
  source: '', sourcePeriod: '', contactGroup: '', emailCount: null, createdAt: '', updatedAt: '' }] });
api.savePerson = async input => {
  contactSaves++;
  return { success: true, data: { ...input, id: 'new-contact', createdAt: '', updatedAt: '' } };
};
api.getShareEmailStatus = async () => {
  if (failSettings) throw new Error('Fixture settings unavailable');
  return { success: true, data: { ...status } };
};
api.saveShareEmailConfig = async input => {
  check(input.password === 'fixture-password', 'Settings send only the entered SMTP password');
  saves++;
  Object.assign(status, { configured: true, username: input.username, replyTo: input.replyTo });
  return { success: true, data: { ...status } };
};
api.verifyShareEmailConfig = async () => { verifies++; return { success: true, data: { verified: true } }; };
api.sendShareEmail = async input => {
  attempts.push(structuredClone(input));
  if (invalidNext) {
    invalidNext = false;
    return { success: false, error: { code: 'VALIDATION_ERROR', message: 'Fixture invalid recipient' } };
  }
  if (attempts.length === 2) {
    smtpSubmissions++;
    await new Promise<void>(resolve => { releaseSend = resolve; });
    throw new Error('Fixture response lost after acceptance');
  }
  if (attempts.length === 3) return { success: true, data: { accepted: 2, rejected: 0 } };
  smtpSubmissions++;
  return { success: true, data: { accepted: 1, rejected: 1 } };
};
function Fixture(): React.ReactElement {
  const [content, setContent] = useState<ShareEmailContent | null>(null);
  return <Theme theme="g100">
    <ShareEmailSettings />
    <button onClick={() => { setContent({ title: 'Published note', url: 'https://github.com/owner/repo/blob/main/notes/test.md' }); }}>Share note fixture</button>
    <button onClick={() => { setContent({ title: 'Diagram fixture', attachment: { filename: 'test.drawio', xml: '<mxfile><diagram /></mxfile>' } }); }}>Share draw.io fixture</button>
    {content && <ShareEmailModal content={content} onClose={() => { setContent(null); }} />}
  </Theme>;
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><Fixture /></MemoryRouter>
  </QueryClientProvider>,
);
function check(condition: boolean, message: string): void { if (!condition) throw new Error(message); }
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Email fixture timed out: ${document.body.innerText}`);
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.offsetParent !== null && item.textContent?.trim() === text);
  if (!found) throw new Error(`Missing email fixture button: ${text}`);
  return found;
}
function field(id: string, value: string): void {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!input) throw new Error(`Missing fixture field ${id}`);
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const composerText = () => document.querySelector('.share-email')?.textContent ?? '';
const open = () => document.querySelector('.share-email') !== null;
async function close(): Promise<void> { button('Cancel').click(); await waitFor(() => !open()); }
export async function runShareEmailChecks(): Promise<string[]> {
  await waitFor(() => document.body.textContent?.includes('Fixture settings unavailable') === true);
  failSettings = false;
  button('Retry').click();
  await waitFor(() => document.body.textContent?.includes('Set up SMTP2GO') === true);
  button('Share note fixture').click();
  await waitFor(() => composerText().includes('before sending'));
  check(button('Send email').disabled, 'Unconfigured composer cannot send');
  check(document.querySelector('.share-email a')?.getAttribute('href') === '/my-work?sync=1', 'Setup link points to integrations');
  await close();
  button('Set up SMTP2GO').click();
  await waitFor(() => document.getElementById('share-smtp-user') !== null);
  field('share-smtp-password', 'fixture-password');
  field('share-reply-to', 'replies@example.com');
  await new Promise(resolve => setTimeout(resolve, 20));
  button('Save settings').click();
  await waitFor(() => document.body.textContent?.includes('Settings saved.') === true);
  check(saves === 1 && document.querySelector('input[type="password"]') === null, 'Saving clears/unmounts password input');
  button('Edit email settings').click();
  await waitFor(() => document.getElementById('share-smtp-password') !== null);
  check((document.getElementById('share-smtp-password') as HTMLInputElement).value === '', 'Saved password is never returned');
  button('Cancel').click();
  await waitFor(() => document.getElementById('share-smtp-password') === null);
  button('Check connection (no email)').click();
  await waitFor(() => document.body.textContent?.includes('SMTP authentication verified') === true);
  check(verifies === 1 && attempts.length === 0, 'Setup/verification never sends mail');
  button('Share note fixture').click();
  await waitFor(() => composerText().includes('published GitHub version'));
  field('share-email-to', '@Example');
  await waitFor(() => document.getElementById('share-contact-0') !== null);
  document.getElementById('share-contact-0')!.click();
  await waitFor(() => (document.getElementById('share-email-to') as HTMLInputElement).value.includes('person@example.com'));
  check(attempts.length === 0 && contactSaves === 0, 'Choosing a contact resolves its address without sending or saving contacts');
  check(composerText().includes('Links do not grant access'), 'Private-link warning is visible');
  field('share-email-to', 'one@example.com, two@example.com');
  field('share-email-message', 'Reviewed message');
  await new Promise(resolve => setTimeout(resolve, 20));
  check(attempts.length === 0, 'Opening/editing the composer never sends automatically');
  button('Send email').click();
  await waitFor(() => composerText().includes('Fixture invalid recipient'));
  check(!(document.getElementById('share-email-to') as HTMLInputElement).disabled, 'Validation errors keep draft editable');
  check((document.getElementById('share-email-message') as HTMLTextAreaElement).value === 'Reviewed message', 'Failed send preserves draft');
  const send = button('Send email');
  send.click(); send.click();
  await waitFor(() => attempts.length === 2);
  button('Cancel').click();
  check(open(), 'In-flight send blocks closing');
  check(attempts.length === 2, 'Double clicks cannot submit twice');
  releaseSend();
  await waitFor(() => composerText().includes('Fixture response lost'));
  check((document.getElementById('share-email-to') as HTMLInputElement).disabled, 'Ambiguous request is frozen for exact retry');
  button('Check / retry same request').click();
  await waitFor(() => composerText().includes('confirms submission, not inbox delivery'));
  check(JSON.stringify(attempts[1]) === JSON.stringify(attempts[2]), 'Explicit retry preserves exact request ID and payload');
  check(smtpSubmissions === 1, 'Lost-response retry does not create another SMTP submission');
  button('Done').click();
  await waitFor(() => !open());
  button('Share draw.io fixture').click();
  await waitFor(() => composerText().includes('test.drawio'));
  field('share-email-to', 'one@example.com, two@example.com');
  await new Promise(resolve => setTimeout(resolve, 20));
  button('Send email').click();
  await waitFor(() => composerText().includes('rejected 1'));
  check(attempts[3]?.attachment?.xml === '<mxfile><diagram /></mxfile>' && !attempts[3]?.url, 'Composer sends reviewed draw.io attachment without inventing a link');
  check(getComputedStyle(document.querySelector('.share-email input')!).backgroundColor !== 'rgba(0, 0, 0, 0)', 'Composer inputs use intentional themed styling');
  return ['Settings recover from failure and never expose saved passwords', 'Connection verification sends no email',
    'Disconnected composer is guarded; published/private link warnings are visible',
    'Manual confirmation, draft retention, validation recovery and double-click protection',
    'Ambiguous sends preserve the exact request for explicit retries', 'Draw.io review and partial-acceptance feedback'];
}
declare global { interface Window { runShareEmailChecks: typeof runShareEmailChecks } }
window.runShareEmailChecks = runShareEmailChecks;
