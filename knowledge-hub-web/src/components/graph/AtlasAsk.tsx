import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import { requireApiData } from '../../services/apiError';
import { AthenaMark } from '../athena/AthenaMark';
import { atlasPathAnswer, mentionedAtlasIds, shortestAtlasPath, type AtlasData } from './atlasData';
import type { AthenaMarkState } from '../../chat/athenaMotion';

export function AtlasAsk({ data, selected, path, onPath, onSelect }: {
  data: AtlasData; selected: string | null; path: string[];
  onPath: (path: string[]) => void; onSelect: (id: string) => void;
}): React.ReactElement {
  const [question, setQuestion] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [state, setState] = useState<AthenaMarkState>('resting');
  const [answer, setAnswer] = useState<{ question: string; text: string } | null>(null);
  const [error, setError] = useState('');
  const run = useRef(0), timers = useRef<number[]>([]);
  const by = new Map(data.nodes.map(n => [n.id, n]));
  const cancel = (): void => { run.current++; timers.current.forEach(window.clearTimeout); timers.current = []; };
  useEffect(() => {
    cancel(); setState('resting'); setAnswer(null); setError('');
    return cancel;
  }, [data]);

  async function ask(explicit?: [string, string]): Promise<void> {
    cancel();
    const current = run.current, started = performance.now();
    setState('thinking'); setAnswer(null); setError(''); onPath([]);
    try {
      let endpoints = explicit;
      if (!endpoints) {
        const targets = requireApiData(await api.suggestLinkTargets(question, ''));
        if (current !== run.current) return;
        const local = mentionedAtlasIds(data, question);
        const resolved = targets.map(t => `${t.type}:${t.id}`);
        const ids = [...new Set(local.length >= 2 ? local : [...local, ...resolved.filter(id => by.has(id))])]
          .sort((a, b) => question.toLowerCase().indexOf(by.get(a)!.name.toLowerCase()) - question.toLowerCase().indexOf(by.get(b)!.name.toLowerCase()));
        if (ids.length === 1 && selected && ids[0] !== selected) ids.unshift(selected);
        if (ids.length !== 2) throw new Error('Name two distinct records in the loaded graph, or choose exact endpoints below. No example or guessed endpoints will be used.');
        endpoints = [ids[0]!, ids[1]!];
      }
      const [a, b] = endpoints;
      if (!by.has(a) || !by.has(b)) throw new Error('An endpoint is outside the loaded graph. Explore its neighbourhood first.');
      const nextPath = shortestAtlasPath(data, a, b);
      const echo = explicit ? `How does ${by.get(a)!.name} connect to ${by.get(b)!.name}?` : question;
      const reveal = (): void => {
        if (current !== run.current) return;
        onPath(nextPath); setAnswer({ question: echo, text: atlasPathAnswer(data, a, b, nextPath) }); setState('answering');
        timers.current.push(window.setTimeout(() => { if (current === run.current) setState('resting'); }, 1800));
      };
      timers.current.push(window.setTimeout(reveal, Math.max(0, 1400 - (performance.now() - started))));
    } catch (reason) {
      if (current !== run.current) return;
      setError(reason instanceof Error ? reason.message : 'Unable to resolve the endpoints. Please try again.');
      setState('resting');
    }
  }
  const busy = state === 'thinking';
  const answerText = answer?.text ?? (path.length ? atlasPathAnswer(data, path[0]!, path.at(-1)!, path) : '');
  return <section className="atlas-ask" aria-labelledby="atlas-ask-title">
    <div className="atlas-ask__heading"><AthenaMark state={state} size={32} /><h2 id="atlas-ask-title">Ask Athena about this map</h2></div>
    <form onSubmit={event => { event.preventDefault(); void ask(); }}>
      <label htmlFor="atlas-question">How are two records connected?</label>
      <div className="atlas-ask__input"><input id="atlas-question" value={question} maxLength={1000}
        placeholder="How does Microsoft connect to IMAGINE?"
        onChange={event => { setQuestion(event.target.value); }} />
        <button className="atlas__athena-action" disabled={busy || !question.trim()} type="submit">Ask</button></div>
    </form>
    <details><summary>Choose exact endpoints</summary>
      <label htmlFor="atlas-from">From</label><select id="atlas-from" value={from || selected || ''} onChange={e => { setFrom(e.target.value); }}>
        <option value="">Choose a record</option>{data.nodes.map(n => <option key={n.id} value={n.id}>{n.name} · {data.types[n.type]!.one}</option>)}
      </select>
      <label htmlFor="atlas-to">To</label><select id="atlas-to" value={to} onChange={e => { setTo(e.target.value); }}>
        <option value="">Choose a record</option>{data.nodes.map(n => <option key={n.id} value={n.id}>{n.name} · {data.types[n.type]!.one}</option>)}
      </select>
      <button className="atlas__athena-action" disabled={busy || !(from || selected) || !to}
        onClick={() => { void ask([from || selected!, to]); }}>Trace connection</button>
    </details>
    {selected && data.nodes.some(n => n.hub && n.id !== by.get(selected)?.project) && <details>
      <summary>Connect to another project</summary>
      {data.nodes.filter(n => n.hub && n.id !== by.get(selected)?.project).map(n => <button key={n.id}
        className="atlas-ask__project" disabled={busy} onClick={() => { void ask([selected, n.id]); }}>How does this connect to {n.name}?</button>)}
    </details>}
    {busy && <p role="status">Tracing connections...</p>}
    {error && <p className="atlas-ask__error" role="alert">{error}</p>}
    {(answer || path.length > 0) && <div className="atlas-ask__answer">
      {answer && <p className="atlas-ask__question">{answer.question}</p>}
      <p role="status">{answerText}</p>
      <ol className="atlas-ask__steps" key={path.join(',')}>
        {path.map((id, index) => {
          const node = by.get(id);
          if (!node) return null;
          const previous = path[index - 1];
          const edge = data.edges.find(e => e.a === previous && e.b === id || e.b === previous && e.a === id);
          const style: React.CSSProperties & { '--atlas-step-delay': string } = { '--atlas-step-delay': `${200 + index * 350}ms` };
          return <li key={id} style={style} className={node.last > 14 && !node.hub ? 'atlas-ask__step atlas-ask__step--quiet' : 'atlas-ask__step'}>
            <button onClick={() => { onSelect(id); }}>{node.name}</button>
            <span>{edge ? `${edge.rel}${edge.inferred ? ' (inferred)' : ''} · ` : ''}{data.types[node.type]!.one}</span>
            {node.last > 14 && !node.hub && <span>Last activity {node.last} days ago</span>}
          </li>;
        })}
      </ol>
      <button onClick={() => { cancel(); setState('resting'); setAnswer(null); onPath([]); }}>Clear path</button>
    </div>}
    <p className="atlas-ask__coverage">Shortest recorded route in the loaded graph. A missing route is not proof that two records are unrelated.</p>
  </section>;
}
