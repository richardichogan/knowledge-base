import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@carbon/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MuralExportDestination } from '../src/components/MuralExportDestination';
import { api, type MuralBoardOption } from '../src/services/api';
import '../src/styles/global.scss';
import '../src/components/connectionTokens.scss';
import '../src/features/diagram/diagram.scss';

const first = 'https://app.mural.co/t/athena5676/m/athena5676/1';
const second = 'https://app.mural.co/t/other1234/m/other1234/2';
let failure = false;
let empty = false;
let calls = 0;
let creates = 0;
let createFailure = false;
api.getMuralRooms = async () => ({ success: true, data: [{ id: 123, name: 'Architecture room', workspace: 'Athena' }] });
api.createMuralBoard = async input => {
  creates++;
  await new Promise(resolve => setTimeout(resolve, 80));
  if (createFailure) throw new Error('Fixture creation response lost');
  return { success: true, data: { id: 'athena5676.99', title: input.title, url: first.replace('/1', '/99'), workspace: 'Athena', archived: false } };
};
const boards: MuralBoardOption[] = [
  { id: 'athena5676.1', title: 'Architecture planning', workspace: 'Athena', archived: false, url: first },
  { id: 'other1234.2', title: 'Architecture planning', workspace: 'Client projects', archived: false, url: second },
  { id: 'other1234.3', title: 'Previous workshop', workspace: 'Client projects', archived: true, url: second.replace('/2', '/3') },
];
api.getMuralBoards = async () => {
  calls++;
  await new Promise(resolve => setTimeout(resolve, 80));
  if (failure) throw new Error('Enable workspaces:read and reconnect in Sources / Integrations.');
  return { success: true, data: empty ? [] : boards };
};
function Fixture(): React.ReactElement {
  const [value, setValue] = useState(first);
  return <Theme theme="g100"><section className="connection-tokens mural-integration dg-export">
    <h3>Mural destination</h3>
    <MuralExportDestination value={value} title="New architecture diagram" disabled={false} onChange={setValue} />
    <button className="dg-primary-btn" disabled={!value} data-send>Send diagram fixture</button>
    <p className="connection-tokens__detail" data-destination>{value}</p>
  </section></Theme>;
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>,
);
const wait = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Mural fixture timed out: ${document.body.innerText}`);
};
const check = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find(item => item.textContent === text);
  if (!found) throw new Error(`Missing ${text}`);
  return found;
};
async function run(): Promise<string[]> {
  await wait(() => document.querySelectorAll('optgroup').length === 2);
  const select = document.querySelector('select')!;
  check(select.value === first, 'Saved default must remain selected');
  check(select.options[3]!.disabled, 'Archived board must not be selectable');
  select.value = second;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(() => document.querySelector('[data-destination]')?.textContent === second);
  check(document.querySelector('a')?.getAttribute('href') === second, 'Destination link must follow selection');
  button('Enter board URL').click();
  await wait(() => document.querySelector('input[type=url]') !== null);
  const input = document.querySelector<HTMLInputElement>('input[type=url]')!;
  check(input.value === second, 'Manual mode must retain selected board');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'javascript:alert(1)');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(() => document.querySelector('[data-destination]')?.textContent === 'javascript:alert(1)');
  check(document.querySelector('a') === null, 'Invalid destination must not become a clickable link');
  button('Choose from my boards').click();
  await wait(() => document.querySelector('select') !== null);
  failure = true;
  button('Refresh boards').click();
  await wait(() => document.querySelector('[role=alert]') !== null);
  check(document.body.innerText.includes('workspaces:read'), 'Scope error must explain reconnect');
  check(calls === 2, 'Failed list requests must not retry automatically');
  failure = false; empty = true;
  button('Refresh boards').click();
  await wait(() => document.body.innerText.includes('No boards were found'));
  check(document.querySelector('select')!.disabled, 'Empty board list must be disabled');
  empty = false;
  button('Refresh boards').click();
  await wait(() => document.querySelectorAll('optgroup').length === 2);
  const restored = document.querySelector('select')!;
  restored.value = first; restored.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(() => document.querySelector('[data-destination]')?.textContent === first);
  button('Create a new Mural').click();
  await wait(() => document.querySelectorAll('select option').length === 2);
  check(document.querySelector<HTMLButtonElement>('[data-send]')!.disabled, 'Export is blocked until new board exists');
  const room = document.querySelector('select')!;
  room.value = '123'; room.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(() => !button('Create and select Mural').disabled);
  check(document.querySelector('input')!.value === 'New architecture diagram', 'New board name defaults to diagram title');
  button('Create and select Mural').click();
  await wait(() => document.querySelector('[data-destination]')?.textContent === first.replace('/1', '/99'));
  check(creates === 1, 'Create exactly one board');
  check(!document.querySelector<HTMLButtonElement>('[data-send]')!.disabled, 'Created board is ready for export');
  button('Create a new Mural').click();
  await wait(() => document.querySelector('input') !== null);
  createFailure = true;
  button('Create and select Mural').click();
  await wait(() => document.querySelector('[role=alert]') !== null);
  check(button('Create and select Mural').disabled, 'Ambiguous creation failure cannot be retried accidentally');
  check(creates === 2, 'No automatic board creation retry');
  button('Add to existing Mural').click();
  await wait(() => document.querySelector('[data-destination]')?.textContent === first.replace('/1', '/99'));
  return ['workspace groups', 'saved destination', 'board selection', 'archived disabled', 'manual URL', 'safe link', 'scope error', 'explicit retry', 'empty list', 'refresh recovery', 'room selection', 'new board name', 'create once', 'creation failure protection', 'existing destination restored'];
}
Object.assign(window, { runMuralBoardChecks: run });
