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
import { AthenaRibbon } from '../src/components/athena/AthenaRibbon';
import { ATHENA_MOODS, useAthenaMood, type AthenaMood } from '../src/chat/athenaMood';
import '../src/styles/global.scss';
import './athena-ribbon.fixture.scss';

interface Scene { phase: AthenaMotionPhase; pending: boolean; answerAt: number | null; complete: boolean; question: boolean; context: string; activity: string }
const idle: Scene = { phase: 'idle', pending: false, answerAt: null, complete: false, question: false, context: 'fixture', activity: 'Thinking' };
const answer = "Here's a first draft of the core IMAGINE story.";
const delay = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));
let setScene: React.Dispatch<React.SetStateAction<Scene>>;
let setWidth: React.Dispatch<React.SetStateAction<number>>;
let run = 0;

async function play(voice = false): Promise<void> {
  const id = ++run;
  setScene({ ...idle, context: `fixture-${id}`, phase: voice ? 'listening' : 'typing' });
  await delay(1200);
  if (id !== run) return;
  setScene(s => ({ ...s, pending: true, question: true, phase: 'thinking' }));
  await delay(1600);
  if (id !== run) return;
  setScene(s => ({ ...s, phase: 'writing', answerAt: Date.now(), pending: false, complete: true }));
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
            <div className="ai-reply-heading" aria-hidden="true"><span className="ai-reply-heading__mark"><AthenaRibbon still /></span><span>Athena</span></div>
            <div className="ai-bubble-text">You own the positioning alignment task.</div>
          </ChatBubble>
          {scene.question && <ChatBubble role="user"><div className="ai-bubble-text">draft the core IMAGINE story</div></ChatBubble>}
          {scene.pending && <LiveReply activity={scene.activity} startedAt={Date.now()} thinkerRef={thinker} />}
          {scene.complete && (
            <ChatBubble role="assistant" arrivalAt={scene.answerAt}>
              <div className="ai-reply-heading" aria-hidden="true"><span ref={mark} className="ai-reply-heading__mark"><AthenaRibbon /></span><span>Athena</span></div>
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
    check(closeTo(centre(sprite), centre(element('.ai-presence-think-anchor'))), 'Thinking must travel to the left column of the pending reply');
    const status = element<HTMLElement>('.ai-live-activity__label');
    check(getComputedStyle(status).textAlign === 'left', 'Wrapped progress updates must share the content column');
    check(status.getBoundingClientRect().top > element('.ai-presence-think-anchor').getBoundingClientRect().bottom, 'Progress updates must stay below the animation');
    const canvas = element('.ai-presence athena-ribbon').shadowRoot!.querySelector<HTMLCanvasElement>('.main')!;
    const firstFrame = canvas.toDataURL();
    await delay(100);
    check(canvas.toDataURL() !== firstFrame, 'The supplied thinking ribbon must twist and rotate');
    const answerAt = Date.now();
    setScene(s => ({ ...s, phase: 'writing', answerAt, pending: false, complete: true }));
    await delay(100);
    const panel = element<HTMLElement>('.ai-answer-arrival .ai-answer-panel');
    check(panel.getBoundingClientRect().width < panel.parentElement!.getBoundingClientRect().width, 'Answer starts growing from the 72px mark surface');
    await delay(650);
    check(panel.getBoundingClientRect().width > 200, 'Answer must unfold across the card');
    check(closeTo(centre(sprite), centre(element('.ai-answer-arrival .ai-reply-heading__mark'))), 'Character must contract into the answer corner');
    setScene(s => ({ ...s }));
    await delay(100);
    check(element('.ai-answer-arrival .ai-answer-panel').getBoundingClientRect().width > 200, 'Rerendering must not restart card expansion');
    await delay(1350);
    check(closeTo(centre(sprite), centre(element('.ai-presence-anchor'))), 'Character must return home after the answer');
    check(getComputedStyle(element('.ai-answer-arrival .ai-reply-heading__mark')).opacity === '1', 'Answer retains the supplied ribbon at its original brightness');
    check(element('.ai-messages').scrollWidth <= element('.ai-messages').clientWidth + 1, 'Chat must not overflow horizontally');
    results.push(`${width}px: idle, travel, live ribbon, single unfold and return`);
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
  const canvas = element('.ai-presence athena-ribbon').shadowRoot!.querySelector<HTMLCanvasElement>('.main')!;
  const paused = canvas.toDataURL();
  await delay(100);
  check(element('.ai-presence').getAttribute('data-paused') === 'true', 'Hidden panels must pause');
  check(canvas.toDataURL() === paused, 'Hidden panels must stop painting frames');
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
    runAthenaRibbonChecks: () => Promise<string[]>;
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
            <div className="ai-reply-heading"><span className="ai-reply-heading__mark"><AthenaRibbon still /></span><span>Athena</span></div>
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

function RibbonFixture(): React.ReactElement {
  const [preview, setPreview] = useState<AthenaMood | null>(null);
  const [phase, setPhase] = useState<AthenaMotionPhase>('idle');
  const [context, setContext] = useState(0);
  const { mood, emote, clearEmotion } = useAthenaMood(phase, String(context));
  const shown = preview ?? mood;
  return <main className="ribbon-fixture">
    <h1>Athena Ribbon</h1>
    <p>Supplied renderer. Synthetic events only; no API calls.</p>
    <div className="ribbon-fixture__hero"><AthenaRibbon mood={shown} size={240} track /></div>
    <div className="ribbon-fixture__controls" aria-label="Preview moods">
      {ATHENA_MOODS.map(m => <button key={m} data-mood={m} aria-pressed={shown === m} onClick={() => { setPreview(m); }}>{m}</button>)}
    </div>
    <div className="ribbon-fixture__controls">
      <button data-event="happy" onClick={() => { setPreview(null); setPhase('idle'); emote('happy'); }}>Positive feedback</button>
      <button data-event="thinking" onClick={() => { setPreview(null); clearEmotion(); setPhase('thinking'); }}>Request sent</button>
      <button data-event="answer" onClick={() => { setPreview(null); setPhase('writing'); }}>Accepted answer</button>
      <button data-event="context" onClick={() => { setPreview(null); setPhase('idle'); setContext(c => c + 1); }}>Switch chat</button>
    </div>
    <section className="ribbon-fixture__chat" aria-label="Chat sizes">
      <div className="ai-character-heading"><AthenaRibbon mood={shown} size={44} silent={false} /><span>Athena</span></div>
      <div className="ribbon-fixture__message"><AthenaRibbon size={32} still /><span>Previous reply: one settled frame.</span></div>
      <div className="ribbon-fixture__message"><AthenaRibbon mood={shown} size={32} /><span>Latest reply: {shown}.</span></div>
    </section>
    <section className="ribbon-fixture__grid" aria-label="All nine supplied moods">
      {ATHENA_MOODS.map(m => <figure key={m}><AthenaRibbon mood={m} size={140} /><figcaption>{m}</figcaption></figure>)}
    </section>
  </main>;
}

window.runAthenaRibbonChecks = async () => {
  const click = (selector: string): void => { element<HTMLButtonElement>(selector).click(); };
  const header = (): Element => element('.ribbon-fixture__chat athena-ribbon');
  check(document.querySelectorAll('.ribbon-fixture__grid athena-ribbon').length === 9, 'All nine moods must be present');
  for (const mood of ATHENA_MOODS) {
    click(`[data-mood="${mood}"]`);
    await delay(50);
    check(header().getAttribute('mood') === mood, `Header must share ${mood}`);
    check(header().shadowRoot!.querySelectorAll('canvas').length === 2, 'Actual ribbon and glow canvases must render');
  }
  check(element('.ribbon-fixture__hero athena-ribbon').getBoundingClientRect().width === 240, 'Welcome character is 240px');
  check(header().getBoundingClientRect().width === 44, 'Header is 44px');
  check(element('.ribbon-fixture__message athena-ribbon').hasAttribute('still'), 'Old messages are still');
  click('[data-event="happy"]');
  await delay(100);
  check(header().getAttribute('mood') === 'happy', 'Positive feedback must be happy');
  await delay(2500);
  check(header().getAttribute('mood') === 'resting', 'Emotion must decay after 2500ms');
  click('[data-event="happy"]');
  await delay(20);
  click('[data-event="thinking"]');
  await delay(20);
  check(header().getAttribute('mood') === 'thinking', 'A new turn must override old emotion');
  click('[data-event="context"]');
  await delay(20);
  check(header().getAttribute('mood') === 'resting', 'Switching chat must clear mood');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'No horizontal overflow');
  return ['All nine supplied moods, 240/44/32px sizes, still history, shared mood events, timed emotion decay and context isolation'];
};
const params = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(params.has('ribbon') ? <RibbonFixture /> : params.has('references') ? <ReferencesFixture /> : <Fixture />);
