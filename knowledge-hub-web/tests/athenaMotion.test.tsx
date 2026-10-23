import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { compileString } from 'sass';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ATHENA_ANSWER_MS, ATHENA_MIN_THINK_MS, ATHENA_TYPING_IDLE_MS, AthenaMotion, athenaExpressiveEase, athenaMarkState, athenaMotionPhase, athenaPosition, microphoneLevel, replyAnchorVisible, type AthenaMotionState } from '../src/chat/athenaMotion';
import { AthenaMark } from '../src/components/athena/AthenaMark';
import { ThinkingReply } from '../src/components/athena/LiveReply';
import { ChatBubble } from '../src/components/athena/ChatBubble';

const idle: AthenaMotionState = { pending: false, activity: '', recording: false, transcribing: false, restoring: false };

test('placement and scrolling use the supplied expressive cubic-bezier', () => {
  assert.equal(athenaExpressiveEase(0), 0);
  assert.ok(Math.abs(athenaExpressiveEase(1) - 1) < 1e-12);
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const x = 3 * (1 - t) ** 2 * t * 0.4 + 3 * (1 - t) * t ** 2 * 0.3 + t ** 3;
    const y = 3 * (1 - t) ** 2 * t * 0.14 + 3 * (1 - t) * t ** 2 + t ** 3;
    assert.ok(Math.abs(athenaExpressiveEase(x) - y) < 1e-6);
  }
});
test('send immediately thinks; typing and voice listen; only accepted answers enter answering', () => {
  assert.equal(athenaMotionPhase(idle), 'idle');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, activity: 'Sending' }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, activity: 'Checking references' }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, answered: true }), 'writing');
  assert.equal(athenaMotionPhase({ ...idle, typing: true }), 'typing');
  assert.equal(athenaMarkState('typing'), 'listening');
  assert.equal(athenaMarkState('listening'), 'listening');
  assert.equal(athenaMarkState('idle'), 'resting');
  assert.equal(athenaMarkState('thinking'), 'thinking');
  assert.equal(athenaMarkState('writing'), 'answering');
  assert.equal(athenaMotionPhase({ ...idle, recording: true }), 'listening');
  assert.equal(athenaMotionPhase({ ...idle, transcribing: true }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, restoring: true }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, recording: true }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, activity: 'Stopped' }), 'idle');
  assert.equal(athenaMotionPhase({ ...idle, activity: 'Error' }), 'idle');
  assert.equal(ATHENA_MIN_THINK_MS, 400);
  assert.equal(ATHENA_TYPING_IDLE_MS, 1500);
});

test('voice level is measured from real PCM and clamped, including silence', () => {
  assert.equal(microphoneLevel(new Float32Array()), 0);
  assert.equal(microphoneLevel(new Float32Array(10)), 0);
  assert.equal(microphoneLevel(new Float32Array([0.125, -0.125])), 0.5);
  assert.equal(microphoneLevel(new Float32Array([1, -1])), 1);
});

test('scrolling or a compact viewport cannot leave the mark over clipped history', () => {
  const thread = { left: 0, top: 80, right: 320, bottom: 480 };
  assert.equal(replyAnchorVisible({ left: 12, top: 120, right: 36, bottom: 144 }, thread), true);
  for (const anchor of [
    { left: 12, top: 60, right: 36, bottom: 84 }, { left: 12, top: 470, right: 36, bottom: 494 },
    { left: 310, top: 120, right: 334, bottom: 144 }, { left: 0, top: 0, right: 0, bottom: 0 },
  ]) assert.equal(replyAnchorVisible(anchor, thread), false);
});

test('compatibility wrapper uses the supplied ribbon without adding keyboard stops', () => {
  const html = renderToStaticMarkup(<AthenaMark state="listening" mode="voice" />);
  assert.match(html, /<athena-ribbon/);
  assert.match(html, /mood="listening"/);
  assert.match(html, /size="32"/);
  assert.match(html, /silent=""/);
  assert.doesNotMatch(html, /tabindex|<button|<input/);
});

test('working state retains actual activity and adds a single helper after eight seconds', () => {
  const render = (seconds: number): string => renderToStaticMarkup(
    <ThinkingReply activity="Searching Library" presenceRef={React.createRef<HTMLSpanElement>()} seconds={seconds} />);
  assert.match(render(3), /role="status">Searching Library/);
  assert.match(render(3), /ai-presence-think-anchor/);
  assert.doesNotMatch(render(7), /Still working/);
  assert.equal([...render(8).matchAll(/Still working/g)].length, 1);
  assert.doesNotMatch(render(20), /cds--loading/);
});

test('motion styles preserve answer growth, ribbon slots, controls and reduced motion', () => {
  const scss = readFileSync(new URL('../src/styles/global.scss', import.meta.url), 'utf8');
  const start = scss.indexOf('.ai-presence {');
  const end = scss.indexOf('// Shown above the composer', start);
  const { css } = compileString(scss.slice(start, end));
  assert.match(css, /ai-answer-grow 400ms/);
  assert.match(css, /72|ai-answer-scale-x/);
  assert.match(css, /translateY\(16px\)/);
  assert.match(css, /athena-ribbon/);
  assert.match(css, /width: 96px/);
  assert.match(css, /width: 32px/);
  assert.match(css, /border-color: var\(--kh-accent\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation: none !important/);
  assert.doesNotMatch(css, /ai-answer-width|ai-answer-height|ai-presence-idle/);
});

test('placement moves from dock to the answer slot and keeps listening at the dock', () => {
  const anchors = { dock: { x: 12, y: 400 }, row: { x: 57, y: 400 }, think: { x: 24, y: 165 }, mark: { x: 30, y: 130 } };
  const home = { row: 0, think: 0, mark: 0, rotation: 0 };
  assert.deepEqual(athenaPosition(home, anchors), anchors.dock);
  assert.deepEqual(athenaPosition({ ...home, think: 1 }, anchors), anchors.think);
  assert.deepEqual(athenaPosition({ ...home, mark: 1 }, anchors), anchors.mark);
  const motion = new AthenaMotion();
  motion.setPhase('typing', 1000);
  assert.deepEqual(athenaPosition(motion.sample(1500).pose, anchors), anchors.dock);
});

test('answer entrance lasts 400ms, holds another 600ms, then travels home over 500ms', () => {
  const motion = new AthenaMotion();
  motion.setPhase('thinking', 1000);
  const working = motion.sample(2200).pose;
  motion.setPhase('writing', 2200, 2200);
  assert.deepEqual(motion.sample(2200).pose, working);
  assert.equal(motion.sample(2600).pose.mark, 1);
  assert.equal(motion.sample(3200).pose.mark, 1);
  assert.ok(motion.sample(3400).pose.mark < 1);
  assert.equal(motion.sample(2200 + ATHENA_ANSWER_MS).pose.mark, 0);
  assert.equal(motion.sample(2200 + ATHENA_ANSWER_MS).active, false);
});

test('rerenders do not restart clocks; cancellation and reduced motion skip answer choreography', () => {
  const motion = new AthenaMotion();
  motion.setPhase('writing', 3000, 3000);
  motion.setPhase('writing', 3800, 3000);
  assert.equal(motion.sample(4500).active, false);
  motion.setPhase('thinking', 6000);
  const first = motion.sample(6200).pose;
  motion.setPhase('thinking', 6200);
  assert.deepEqual(motion.sample(6200).pose, first);
  assert.equal(motion.sample(66000, true).active, false);
  motion.setPhase('idle', 66000);
  assert.equal(motion.sample(66500).pose.think, 0);
  assert.equal(motion.sample(66500).pose.mark, 0);
  motion.setPhase('writing', 70000, 70000);
  assert.equal(motion.sample(70000, true).pose.mark, 0);
});

test('accepted replies opt into the entrance but restored history does not', () => {
  const answer = renderToStaticMarkup(<ChatBubble role="assistant" arrivalAt={Date.now() - 100}>Real answer</ChatBubble>);
  assert.match(answer, /ai-answer-panel/);
  assert.match(answer, /ai-answer-arrival/);
  assert.match(answer, /--ai-arrival-delay:-\d+ms/);
  assert.doesNotMatch(renderToStaticMarkup(<ChatBubble role="assistant">History</ChatBubble>), /ai-answer-arrival/);
});
