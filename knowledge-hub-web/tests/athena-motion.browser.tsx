import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AthenaPresence } from '../src/components/athena/AthenaPresence';
import { LiveReply } from '../src/components/athena/LiveReply';
import { ChatBubble } from '../src/components/athena/ChatBubble';
import { ReplyMeta } from '../src/components/athena/ReplyMeta';
import { UsedLine } from '../src/components/athena/UsedLine';
import { ReplyAlternates } from '../src/components/athena/ReplyAlternates';
import type { ContextUsedApi } from '../src/types';
import type { AthenaMotionPhase } from '../src/chat/athenaMotion';
import '../src/styles/global.scss';

interface Scene { phase: AthenaMotionPhase; pending: boolean; answerAt: number | null; complete: boolean; question: boolean; context: string; activity: string }
const idle: Scene = { phase: 'idle', pending: false, answerAt: null, complete: false, question: false, context: 'fixture', activity: 'Thinking' };
const answer = "Here's a first draft of the core IMAGINE story.";
const delay = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));
let setScene: React.Dispatch<React.SetStateAction<Scene>>;
let setWidth: React.Dispatch<React.SetStateAction<number>>;
let run = 0;

async function play(voice = false): Promise<void> {
  const id = ++run;
  setScene({ ...idle, context: `fixture-${id}`, phase: voice ? 'listening' : 'sending' });
  await delay(1200);
  if (id !== run) return;
  setScene(s => ({ ...s, pending: true, question: true, phase: 'thinking' }));
  await delay(1600);
  if (id !== run) return;
  setScene(s => ({ ...s, phase: 'writing', answerAt: Date.now() }));
  await delay(900);
  if (id !== run) return;
  setScene(s => ({ ...s, pending: false, complete: true }));
}

function Fixture(): React.ReactElement {
  const [scene, updateScene] = useState(idle);
  const [width, updateWidth] = useState(900);
  const host = useRef<HTMLDivElement>(null), thread = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLSpanElement>(null), thinker = useRef<HTMLSpanElement>(null), mark = useRef<HTMLSpanElement>(null);
  useEffect(() => { setScene = updateScene; setWidth = updateWidth; }, []);
  return (
    <div className="motion-fixture" style={{ width }}>
      <div className="motion-fixture__tools">
        <button onClick={() => { void play(); }}>Play text</button>
        <button onClick={() => { void play(true); }}>Play voice</button>
        <button onClick={() => { run++; updateScene({ ...idle, context: `reset-${run}` }); }}>Reset</button>
        <label><input type="checkbox" checked={width === 400} onChange={e => { updateWidth(e.target.checked ? 400 : 900); }} />Compact</label>
        <span>Fixture content only. No API calls.</span>
      </div>
      <div ref={host} className={`ai-conversation${width <= 400 ? ' ai-chat-compact__body' : ''}`}>
        <AthenaPresence phase={scene.phase} pending={scene.pending} answerAt={scene.answerAt} contextKey={scene.context}
          host={host} thread={thread} dock={dock} thinker={thinker} reply={mark} />
        <div ref={thread} className="ai-messages">
          <ChatBubble role="assistant">
            <div className="ai-reply-heading" aria-hidden="true"><span className="ai-reply-heading__mark" /><span>Athena</span></div>
            <div className="ai-bubble-text">You own the positioning alignment task.</div>
          </ChatBubble>
          {scene.question && <ChatBubble role="user"><div className="ai-bubble-text">draft the core IMAGINE story</div></ChatBubble>}
          {scene.pending && <LiveReply activity={scene.activity} startedAt={Date.now()} text={scene.phase === 'writing' ? answer : ''}
            renderContext={{}} presenceRef={mark} thinkerRef={thinker} arrivalAt={scene.answerAt} />}
          {scene.complete && (
            <ChatBubble role="assistant" arrivalAt={scene.answerAt}>
              <div className="ai-reply-heading" aria-hidden="true"><span ref={mark} className="ai-reply-heading__mark" /><span>Athena</span></div>
              <div className="ai-bubble-text">{answer}</div>
              <div className="ai-output-chips"><button className="ai-output-chip">IMAGINE core story · v1 <span className="ai-output-chip__open">Saved to Outputs</span></button></div>
            </ChatBubble>
          )}
        </div>
        <div className={`ai-composer${scene.phase === 'listening' || scene.phase === 'sending' ? ' ai-composer--asking' : ''}`}>
          <div className="ai-presence-dock"><span ref={dock} className="ai-presence-anchor" /></div>
          <div className="ai-input-row"><div className="ai-input-field"><input aria-label="Preview composer" className="ai-input-textarea" placeholder={scene.phase === 'listening' ? 'Listening…' : 'Ask Athena…'} /></div></div>
        </div>
      </div>
    </div>
  );
}

const element = <T extends Element>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`Missing ${selector}`);
  return node;
};
const check = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
const centre = (node: Element): { x: number; y: number } => {
  const rect = node.getBoundingClientRect();
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
};
const closeTo = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.hypot(a.x - b.x, a.y - b.y) < 2;

async function runChecks(): Promise<string[]> {
  ++run;
  const results: string[] = [];
  for (const width of [900, 400, 390]) {
    setWidth(width);
    setScene({ ...idle, context: `check-${width}` });
    await delay(100);
    const sprite = element<HTMLElement>('.ai-presence');
    check(getComputedStyle(sprite).visibility === 'visible', 'Idle character must be visible on initial mount');
    check(closeTo(centre(sprite), centre(element('.ai-presence-anchor'))), 'Idle character must be docked');
    setScene(s => ({ ...s, pending: true, question: true, phase: 'thinking', activity: 'Checking the related project notes and searching your Library for the supporting details before preparing the answer' }));
    await delay(650);
    check(closeTo(centre(sprite), centre(element('.ai-presence-think-anchor'))), 'Thinking must travel to the centre of the pending reply');
    const status = element<HTMLElement>('.ai-live-activity__label');
    check(getComputedStyle(status).textAlign === 'center', 'Wrapped progress updates must stay centred');
    check(status.getBoundingClientRect().top > element('.ai-presence-think-anchor').getBoundingClientRect().bottom, 'Progress updates must stay below the animation');
    const pieces = [...document.querySelectorAll<HTMLElement>('.ai-presence-glyph__piece')];
    check(pieces.every(piece => getComputedStyle(piece).borderRadius === '0px'), 'Thinking pieces must be squares');
    const firstTransform = pieces[0]!.style.transform;
    await delay(100);
    check(pieces[0]!.style.transform !== firstTransform, 'Thinking squares must rotate and breathe');
    const answerAt = Date.now();
    setScene(s => ({ ...s, phase: 'writing', answerAt }));
    await delay(100);
    const panel = element<HTMLElement>('.ai-bubble--live .ai-answer-panel');
    check(panel.getBoundingClientRect().width < 40 && panel.getBoundingClientRect().height < 40, 'Answer must begin as the supplied 36px panel');
    await delay(650);
    check(panel.getBoundingClientRect().width > 200, 'Answer must unfold across the card');
    check(closeTo(centre(sprite), centre(element('.ai-bubble--live .ai-reply-heading__mark'))), 'Character must contract into the answer corner');
    setScene(s => ({ ...s, pending: false, complete: true }));
    await delay(100);
    check(element('.ai-answer-arrival .ai-answer-panel').getBoundingClientRect().width > 200, 'Completing the stream must not restart card expansion');
    await delay(1350);
    check(closeTo(centre(sprite), centre(element('.ai-presence-anchor'))), 'Character must return home after the answer');
    check(getComputedStyle(element('.ai-answer-arrival .ai-reply-heading__mark')).opacity === '1', 'Answer must retain its grey mark');
    check(element('.ai-messages').scrollWidth <= element('.ai-messages').clientWidth + 1, 'Chat must not overflow horizontally');
    results.push(`${width}px: idle, travel, morph, rotation, unfold, stream handoff, grey mark and return`);
  }
  setScene({ ...idle, pending: true, question: true, phase: 'thinking', context: 'stop-check' });
  await delay(650);
  const departure = centre(element('.ai-presence'));
  setScene(s => ({ ...s, pending: false, phase: 'idle' }));
  await delay(30);
  check(Math.hypot(centre(element('.ai-presence')).x - departure.x, centre(element('.ai-presence')).y - departure.y) < 10, 'Removing the thinking anchor must not teleport the character');
  await delay(550);
  check(closeTo(centre(element('.ai-presence')), centre(element('.ai-presence-anchor'))), 'Stopped turn must return without an answer celebration');
  results.push('Stop interrupts the choreography');
  setScene({ ...idle, pending: true, question: true, phase: 'thinking', context: 'visibility-check' });
  await delay(650);
  const thread = element<HTMLElement>('.ai-messages');
  const spacer = document.createElement('div');
  spacer.style.cssText = 'height:1500px;flex-shrink:0';
  thread.append(spacer);
  thread.scrollTop = thread.scrollHeight;
  await delay(100);
  check(closeTo(centre(element('.ai-presence')), centre(element('.ai-presence-anchor'))), 'Scrolling away must not leave the thinker over unrelated history');
  spacer.remove();
  thread.scrollTop = 0;
  await delay(100);
  check(closeTo(centre(element('.ai-presence')), centre(element('.ai-presence-think-anchor'))), 'Scrolling back must restore the thinking position');
  const host = element<HTMLElement>('.ai-conversation');
  host.style.display = 'none';
  await delay(100);
  const paused = element<HTMLElement>('.ai-presence-glyph__piece').style.transform;
  await delay(100);
  check(element('.ai-presence').getAttribute('data-paused') === 'true', 'Hidden panels must pause');
  check(element<HTMLElement>('.ai-presence-glyph__piece').style.transform === paused, 'Hidden panels must stop painting frames');
  host.style.display = '';
  results.push('Scroll fallback and hidden-panel pausing');
  setScene({ ...idle, phase: 'thinking', context: 'visibility-check' });
  await delay(100);
  check(closeTo(centre(element('.ai-presence')), centre(element('.ai-presence-anchor'))), 'Preparation without a reply anchor must stay at the composer, not reuse an old reply position');
  setWidth(900);
  setScene(idle);
  return results;
}

declare global {
  interface Window {
    runAthenaMotionChecks: typeof runChecks;
    playAthenaMotion: typeof play;
    setAthenaMotionScene: (scene: Partial<Scene>) => void;
  }
}
function ReferencesFixture(): React.ReactElement {
  const [excluded, setExcluded] = useState(new Set<string>());
  const [compact, setCompact] = useState(false);
  const used: ContextUsedApi = {
    project: 'IBM Thought Leadership', instructions: 8, inView: 'Reaching for the Cloud: Edition 42',
    outputs: 0, decisions: 2, screens: 0, auto: [],
    found: [
      { id: 'fixture-note', title: 'Reaching for the Cloud: Edition 42 — background and supporting references', kind: 'note', lifecycle: 'cited', url: 'https://example.invalid/reference' },
      { id: 'fixture-doc', title: 'Supporting project material with a longer title that needs to wrap neatly in the narrow chat panel', kind: 'document', lifecycle: 'read' },
    ],
  };
  return (
    <div className="motion-fixture" style={{ width: compact ? 390 : 900 }}>
      <div className="motion-fixture__tools">
        <label><input type="checkbox" checked={compact} onChange={e => { setCompact(e.target.checked); }} />Compact</label>
        <span>Reference styling fixture. No API calls.</span>
      </div>
      <div className={`ai-conversation${compact ? ' ai-chat-compact__body' : ''}`}>
        <div className="ai-messages">
          <ChatBubble role="assistant">
            <div className="ai-reply-heading"><span className="ai-reply-heading__mark" /><span>Athena</span></div>
            <div className="ai-bubble-text">You’re welcome, Richard.</div>
            <div className="ai-reply-references">
              <ReplyMeta persona="blog_post" />
              <UsedLine used={used} excluded={excluded} onExclude={source => { setExcluded(new Set([...excluded, source.id])); }}
                onInclude={id => { setExcluded(new Set([...excluded].filter(item => item !== id))); }} />
            </div>
            <ReplyAlternates sessionId="fixture" messageId="fixture" alternates={[]} models={[{ id: 'fixture', label: 'Preview only', current: true }]}
              renderContext={{}} onAdded={() => { throw new Error('Fixture must not request another answer'); }} onUsed={() => { throw new Error('Fixture must not change saved answers'); }} />
          </ChatBubble>
        </div>
      </div>
    </div>
  );
}

window.runAthenaMotionChecks = runChecks;
window.playAthenaMotion = play;
window.setAthenaMotionScene = scene => { ++run; setScene(current => ({ ...current, ...scene })); };
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('references') ? <ReferencesFixture /> : <Fixture />);
