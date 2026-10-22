import React from 'react';
import type { GraphNode } from '../../services/api';
import { activityTime, DAY_MS } from './atlasModel';

export function AtlasTimeline({ nodes, now, endDay, onChange, playing, onPlay, reducedMotion, currentCount, previousCount }: {
  nodes: GraphNode[]; now: number; endDay: number; onChange: (day: number) => void;
  playing: boolean; onPlay: () => void; reducedMotion: boolean; currentCount: number; previousCount: number;
}): React.ReactElement {
  const format = (time: number): string => new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const bins = Array.from({ length: 53 }, (_, i) => nodes.filter(n => {
    const age = (now - activityTime(n)) / DAY_MS; return age >= i * 7 && age < (i + 1) * 7;
  }).length).reverse();
  const max = Math.max(1, ...bins);
  return <section className="atlas-timeline" aria-label="Graph activity timeline">
    <div className="atlas-timeline__heading"><h2>Activity, not historical state</h2>
      <span>{format(now - (endDay + 7) * DAY_MS)} – {format(now - endDay * DAY_MS)}</span>
      <button disabled={reducedMotion} onClick={onPlay} aria-pressed={playing}>{playing ? 'Pause' : 'Play activity'}</button>
    </div>
    <svg viewBox="0 0 530 36" preserveAspectRatio="none" aria-hidden="true" className="atlas-timeline__histogram">
      {bins.map((count, i) => <rect key={i} x={i * 10} y={36 - count / max * 34} width={7} height={count / max * 34} />)}
    </svg>
    <label htmlFor="atlas-time">Move the seven-day activity window</label>
    <input id="atlas-time" type="range" min={0} max={358} value={358 - endDay}
      onChange={e => { onChange(358 - Number(e.target.value)); }} />
    <p><strong>{currentCount}</strong> records last changed in this window · <strong>{previousCount}</strong> in the preceding week.
      {' '}Connected older records remain as context. Dates describe source updates or index changes, not when a real-world event happened.
      Deleted records and earlier revisions are not reconstructed.{reducedMotion ? ' Playback is disabled for reduced motion; the slider remains available.' : ''}</p>
  </section>;
}
