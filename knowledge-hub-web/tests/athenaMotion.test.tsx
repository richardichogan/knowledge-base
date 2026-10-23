import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { compileString } from 'sass';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ATHENA_ANSWER_MS, AthenaMotion, athenaGlyphFrame, athenaMotionPhase, athenaPosition, replyAnchorVisible, type AthenaMotionState } from '../src/chat/athenaMotion';
import { AthenaGlyph } from '../src/components/athena/AthenaPresence';
import { LiveReply } from '../src/components/athena/LiveReply';
import { ChatBubble } from '../src/components/athena/ChatBubble';

const idle: AthenaMotionState = {
  pending: false, activity: '', recording: false, transcribing: false, restoring: false,
};

test('motion waits for the accepted answer instead of revealing provisional model rounds', () => {
  assert.equal(athenaMotionPhase(idle), 'idle');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, activity: 'Sending' }), 'sending');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, activity: 'Reading your Library' }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, activity: 'Checking references' }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, answered: true }), 'writing');
  assert.equal(athenaMotionPhase({ ...idle, activity: 'Stopped' }), 'idle');
  assert.equal(athenaMotionPhase({ ...idle, activity: 'Error' }), 'idle');
  assert.equal(athenaMotionPhase({ ...idle, typing: true }), 'sending');
  assert.equal(athenaMotionPhase({ ...idle, answered: true }), 'writing');
  assert.equal(athenaMotionPhase({ ...idle, typing: true, answered: true }), 'sending');
});

test('voice and restored turns use their actual state, not a simulated voice meter', () => {
  assert.equal(athenaMotionPhase({ ...idle, recording: true }), 'listening');
  assert.equal(athenaMotionPhase({ ...idle, transcribing: true }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, restoring: true }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, recording: true }), 'thinking');
  assert.equal(athenaMotionPhase({ ...idle, pending: true, activity: 'Recovered turn' }), 'thinking');
});

test('scrolling or a compact viewport cannot leave the character over clipped history', () => {
  const thread = { left: 0, top: 80, right: 320, bottom: 480 };
  assert.equal(replyAnchorVisible({ left: 12, top: 120, right: 36, bottom: 144 }, thread), true);
  assert.equal(replyAnchorVisible({ left: 12, top: 60, right: 36, bottom: 84 }, thread), false);
  assert.equal(replyAnchorVisible({ left: 12, top: 470, right: 36, bottom: 494 }, thread), false);
  assert.equal(replyAnchorVisible({ left: 310, top: 120, right: 334, bottom: 144 }, thread), false);
  assert.equal(replyAnchorVisible({ left: 0, top: 0, right: 0, bottom: 0 }, thread), false);
});

test('the four-piece character is decorative and adds no keyboard stops', () => {
  const html = renderToStaticMarkup(<AthenaGlyph />);
  assert.equal([...html.matchAll(/class="ai-presence-glyph__piece"/g)].length, 4);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /tabindex|<button|<input/);
});

test('live activity keeps a textual status and a decorative character anchor', () => {
  const props = {
    activity: 'Searching Library', startedAt: Date.now(), thinkerRef: React.createRef<HTMLSpanElement>(),
  };
  const thinking = renderToStaticMarkup(<LiveReply {...props} />);
  assert.match(thinking, /role="status">Searching Library/);
  assert.match(thinking, /ai-presence-think-anchor/);
  assert.doesNotMatch(thinking, /cds--loading/);
  assert.match(thinking, /ai-live-activity__time" aria-hidden="true"/);
});

test('motion styles compile with static reduced-motion states and hidden-view pausing', () => {
  const scss = readFileSync(new URL('../src/styles/global.scss', import.meta.url), 'utf8');
  const start = scss.indexOf('.ai-presence {');
  const end = scss.indexOf('// Shown above the composer', start);
  assert.ok(start >= 0 && end > start);
  const { css } = compileString(scss.slice(start, end));
  assert.match(css, /data-paused=true[\s\S]*?animation-play-state: paused/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important;[\s\S]*?transition: none !important;/);
  assert.match(css, /ai-presence-idle 1.7s/);
  assert.match(css, /ai-answer-width 450ms[\s\S]*?\+ 150ms/);
  assert.match(css, /ai-answer-height 450ms[\s\S]*?\+ 250ms/);
  for (const delay of [550, 650, 900, 1600]) assert.ok(css.includes(`+ ${delay}ms`));
  assert.match(scss, /--ai-motion-color-0: #4589ff/);
  assert.match(css, /pointer-events: none/);
});

const home = { row: 0, think: 0, mark: 0, rotation: 0 };
test('v3 geometry preserves quarter-circle morph, row spacing, square colours and smaller answer mark', () => {
  const circle = athenaGlyphFrame(home, 0, false);
  assert.deepEqual(circle.map(p => [p.x, p.y, p.size]), [[-5, -5, 10], [5, -5, 10], [-5, 5, 10], [5, 5, 10]]);
  assert.deepEqual(circle.map(p => p.radius), [[10, 0, 0, 0], [0, 10, 0, 0], [0, 0, 0, 10], [0, 0, 10, 0]]);
  const dots = athenaGlyphFrame({ ...home, row: 1 }, 0, false);
  assert.deepEqual(dots.map(p => p.x), [-18, -6, 6, 18]);
  assert.ok(dots.every(p => p.size === 7 && p.radius.every(r => r === 3.5)));
  const squares = athenaGlyphFrame({ ...home, think: 1 }, 0, false);
  assert.deepEqual(squares.map(p => p.colorIndex), [0, 1, 3, 2]);
  assert.ok(squares.every(p => p.size === 15 && p.colorMix === 1 && p.radius.every(r => r === 0)));
  const mark = athenaGlyphFrame({ ...home, mark: 1 }, 0, false);
  assert.ok(mark.every(p => p.size === 6 && p.colorMix === 0));
  const voice = athenaGlyphFrame({ ...home, row: 1 }, 0.35, true);
  const text = athenaGlyphFrame({ ...home, row: 1 }, 0.35, false);
  assert.notDeepEqual(voice.map(p => p.y), text.map(p => p.y));
});

test('the actor travels through dock, input row, central thinker and answer corner', () => {
  const anchors = { dock: { x: 12, y: 400 }, row: { x: 57, y: 400 }, think: { x: 240, y: 165 }, mark: { x: 30, y: 130 } };
  assert.deepEqual(athenaPosition(home, anchors), anchors.dock);
  assert.deepEqual(athenaPosition({ ...home, row: 1 }, anchors), anchors.row);
  assert.deepEqual(athenaPosition({ ...home, think: 1 }, anchors), anchors.think);
  assert.deepEqual(athenaPosition({ ...home, mark: 1 }, anchors), anchors.mark);
});

test('answer contracts, holds, leaves its mark and rotates home at the supplied offsets', () => {
  const motion = new AthenaMotion();
  motion.setPhase('thinking', 1000);
  const working = motion.sample(2200).pose;
  motion.setPhase('writing', 2200, 2200);
  assert.deepEqual(motion.sample(2200).pose, working, 'the transition cannot jump on its first frame');
  assert.equal(motion.sample(2500).pose.mark, 1);
  assert.equal(motion.sample(3800).pose.mark, 1);
  assert.ok(motion.sample(4000).pose.mark < 1);
  assert.equal(motion.sample(2200 + ATHENA_ANSWER_MS).pose.mark, 0);
  assert.equal(motion.sample(2200 + ATHENA_ANSWER_MS).pose.rotation, 360);
  assert.equal(motion.sample(2200 + ATHENA_ANSWER_MS).active, false);
});

test('rerenders retain the answer clock; interruption and reduced motion bypass the old sequence', () => {
  const motion = new AthenaMotion();
  motion.setPhase('writing', 3000, 3000);
  motion.setPhase('writing', 3800, 3000);
  assert.equal(motion.sample(5100).active, false);
  motion.setPhase('thinking', 6000);
  assert.ok(Number.isFinite(motion.sample(66000).pose.rotation));
  assert.equal(motion.sample(66000, true).active, false);
  motion.setPhase('idle', 66000);
  assert.equal(motion.sample(66500).pose.think, 0);
  assert.equal(motion.sample(66500).pose.mark, 0);
  motion.setPhase('writing', 70000, 70000);
  const reduced = motion.sample(70000, true).pose;
  assert.deepEqual({ ...reduced, rotation: reduced.rotation % 360 }, home);
  motion.setPhase('sending', 70500);
  assert.equal(motion.sample(70750).pose.row, 1);
  assert.equal(motion.sample(70750).pose.mark, 0);
});

test('answer surface and new question opt into choreography, but restored history does not', () => {
  const answer = renderToStaticMarkup(<ChatBubble role="assistant" arrivalAt={Date.now() - 1000}>Real answer</ChatBubble>);
  assert.match(answer, /ai-answer-panel/);
  assert.match(answer, /ai-answer-arrival/);
  assert.match(answer, /--ai-arrival-delay:-1\d{3}ms/);
  const restored = renderToStaticMarkup(<ChatBubble role="assistant">History</ChatBubble>);
  assert.doesNotMatch(restored, /ai-answer-arrival/);
  const question = renderToStaticMarkup(<ChatBubble role="user" arrivalAt={Date.now()}>Question</ChatBubble>);
  assert.match(question, /ai-question-arrival/);
});
