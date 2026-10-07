import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertDialog, confirmDialog, currentDialog, settleDialog, subscribeDialogs } from '../src/services/appDialogs';

test('dialogs queue, cancel safely and only settle the active request once', async () => {
  let notifications = 0;
  const unsubscribe = subscribeDialogs(() => { notifications++; });
  const first = confirmDialog('Delete?', { tone: 'danger' });
  const second = alertDialog('Saved', { tone: 'success' });
  const id = currentDialog()!.id;
  assert.equal(currentDialog()!.kind, 'confirm');
  settleDialog(id + 100, true);
  assert.equal(currentDialog()!.id, id);
  settleDialog(id, false);
  assert.equal(await first, false);
  assert.equal(currentDialog()!.kind, 'alert');
  const alertId = currentDialog()!.id;
  settleDialog(id, true);
  assert.equal(currentDialog()!.id, alertId);
  settleDialog(alertId, true);
  await second;
  assert.equal(currentDialog(), null);
  assert.equal(notifications, 4);
  unsubscribe();
});
