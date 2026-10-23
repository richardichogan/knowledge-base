import assert from 'node:assert/strict';
import test from 'node:test';
import { LONG_PROMPT_MS, notifyPromptCompleted, requestCompletionNotifications } from '../src/chat/completionNotification';

test('long prompt notifications enforce the exact threshold, permissions, deduplication and safe navigation', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalNow = Date.now;
  const notifications: FakeNotification[] = [];
  let requests = 0, destination = '', focused = false;
  class FakeNotification {
    static permission = 'granted';
    static async requestPermission() { requests++; return 'granted'; }
    onclick = () => {};
    onerror = () => {};
    closed = false;
    constructor(readonly title: string, readonly options: NotificationOptions) { notifications.push(this); }
    close() { this.closed = true; }
  }
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FakeNotification });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    focus: () => { focused = true; }, location: { assign: (url: string) => { destination = url; } },
  } });
  Date.now = () => 100_000;
  try {
    notifyPromptCompleted('fast', 100_000 - LONG_PROMPT_MS, 'session');
    notifyPromptCompleted('invalid', NaN, 'session');
    assert.equal(notifications.length, 0);
    FakeNotification.permission = 'denied';
    requestCompletionNotifications();
    notifyPromptCompleted('denied', 0, 'session');
    assert.equal(requests, 0);
    assert.equal(notifications.length, 0);
    FakeNotification.permission = 'default';
    requestCompletionNotifications();
    await Promise.resolve();
    assert.equal(requests, 1);
    FakeNotification.permission = 'granted';
    notifyPromptCompleted('slow', 100_000 - LONG_PROMPT_MS - 1, 'a&b');
    notifyPromptCompleted('slow', 0, 'a&b');
    assert.equal(notifications.length, 1);
    notifications[0]!.onclick();
    assert.equal(destination, '/chat?session=a%26b');
    assert.ok(focused && notifications[0]!.closed);
    notifyPromptCompleted('note', 0, 'session', 'a&b');
    notifications[1]!.onclick();
    assert.equal(destination, '/think?view=notes&noteId=a%26b');
  } finally {
    Date.now = originalNow;
    if (original) Object.defineProperty(globalThis, 'Notification', original);
    else Reflect.deleteProperty(globalThis, 'Notification');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
