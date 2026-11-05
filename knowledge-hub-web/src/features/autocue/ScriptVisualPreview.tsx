import { useEffect, useRef, useState } from 'react';
import { parseScriptVisuals, scriptVisualSource, type VisualScriptBlock } from '../../../../knowledge-hub-backend/src/utils/scriptVisuals';
import css from '../../../../athena-desktop/assets/visuals.css?raw';
import { createVisualRenderer, type VisualPacket } from '../../../../athena-desktop/assets/visuals.js';
import './scriptVisuals.scss';

export function ScriptVisualPreview({ section, ask, proposed = false, presentationTitle = '', pageOffset = 0, totalScenes }: {
  section: VisualScriptBlock; ask: (sceneId?: string) => void; proposed?: boolean;
  presentationTitle?: string; pageOffset?: number; totalScenes?: number;
}): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const renderer = useRef<((packet: VisualPacket) => void) | null>(null);
  const [step, setStep] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const raw = section.props?.scriptVisuals;
  let plan: ReturnType<typeof parseScriptVisuals> | null = null;
  let error: string | null = null;
  try { if (raw) plan = parseScriptVisuals(raw); }
  catch (err) { error = err instanceof Error ? err.message : 'The visuals could not be read.'; }
  const stale = !proposed && !!plan && plan.source !== scriptVisualSource(section);
  const frames = plan?.scenes.flatMap(scene => [
    { scene, revealed: 0 }, ...scene.items.map((_item, index) => ({ scene, revealed: index + 1 })),
  ]) ?? [];
  const current = step < 0 && plan?.scenes[0]
    ? { scene: plan.scenes[0], revealed: plan.scenes[0].items.length } : frames[Math.max(0, step)] ?? null;
  useEffect(() => { setStep(-1); setPlaying(false); }, [raw]);
  useEffect(() => {
    const host = frame.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const styles = document.createElement('style');
    styles.textContent = css.replaceAll('100vh', '100cqh').replaceAll('vw', 'cqw').replaceAll('vh', 'cqh')
      .replaceAll('position: fixed', 'position: absolute');
    const root = document.createElement('div');
    root.className = 'visual-root';
    const stage = document.createElement('main');
    stage.setAttribute('aria-label', 'Presentation visual');
    const status = document.createElement('p');
    status.id = 'status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    root.append(stage, status);
    shadow.replaceChildren(styles, root);
    renderer.current = createVisualRenderer(stage, status, root);
    return () => { renderer.current = null; shadow.replaceChildren(); };
  }, [!!plan]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const page = current && plan ? pageOffset + plan.scenes.findIndex(scene => scene.id === current.scene.id) + 1 : 0;
    renderer.current?.({
      scene: current?.scene ?? null, revealed: current?.revealed ?? 0, error: null,
      presentationTitle, page, total: totalScenes ?? plan?.scenes.length ?? 0,
    });
    window.dispatchEvent(new Event('athena:script-visual-context'));
  }, [raw, step, presentationTitle, pageOffset, totalScenes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (step + 1 >= frames.length) setPlaying(false);
      else setStep(value => value + 1);
    }, 1400);
    return () => { clearTimeout(timer); };
  }, [playing, step, frames.length]);
  return <section className="kh-script-visuals" contentEditable={false} aria-label="Section visuals"
    data-visual-section={section.id} data-visual-scene={current?.scene.id ?? ''}>
    <div className="kh-script-visuals__actions">
      <span>Visuals</span>
      {plan && <button type="button" disabled={stale || !!error} onClick={() => {
        if (playing) setPlaying(false);
        else { setStep(0); setPlaying(true); }
      }}>{playing ? 'Pause preview' : 'Play preview'}</button>}
      {plan && <span>{current?.scene.presenterLayout ? 'Presenter layout' : 'Full frame'}</span>}
      <button type="button" onClick={() => { ask(current?.scene.id); }}>Ask Athena to {raw ? 'update' : 'create'}</button>
    </div>
    {error ? <p role="alert">{error}</p> : plan
      ? <><div ref={frame} className="kh-script-visuals__stage" role="img" aria-label={[
          current?.scene.title, current?.scene.subtitle, current?.scene.artwork?.description, current?.scene.imageAlt,
          current?.scene.presenterLayout ? 'Presenter layout: video space reserved at lower right' : '',
          ...(current?.scene.composition
            ? current.scene.composition.nodes.filter(node => node.reveal <= current.revealed).map(node => [node.label, node.detail].filter(Boolean).join(': '))
            : current?.scene.items.slice(0, current.revealed).map(item => [item.label, item.detail].filter(Boolean).join(': ')) ?? []),
        ].filter(Boolean).join('. ')} />
        <p>{stale ? 'Script changed. Ask Athena to update these visuals before presenting.' : 'Preview only. Live reveals follow the Elgato reading position.'}</p></>
      : <p>No visuals yet. Ariadne can explain this section through concepts, key messages and progressive animation.</p>}
  </section>;
}
