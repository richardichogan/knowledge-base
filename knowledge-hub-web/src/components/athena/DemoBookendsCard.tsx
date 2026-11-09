/**
 * Intro and exit pages for a solution demo, rendered in Athena's reply with the script visuals' own renderer
 * (opening title and end page) and downloadable as 1920x1080 PNGs for video editing.
 */
import { useEffect, useRef, useState } from 'react';
import { Download } from '@carbon/icons-react';
import { toPng } from 'html-to-image';
import css from '../../../../athena-desktop/assets/visuals.css?raw';
import { createVisualRenderer, type VisualPacket } from '../../../../athena-desktop/assets/visuals.js';
import type { DemoBookends } from '../../../../knowledge-hub-backend/src/utils/demoBookends';

type Page = 'intro' | 'exit';

type Scene = NonNullable<VisualPacket['scene']>;

function sceneFor(bookends: DemoBookends, page: Page): Scene {
  if (page === 'intro') {
    const scene: Scene = { id: 'demo-intro', template: 'title', title: bookends.intro.title, subtitle: bookends.intro.subtitle, imageUrl: '', imageAlt: '', items: [] };
    if (bookends.intro.label !== '') scene.composition = { label: bookends.intro.label, imagePrompt: '', nodes: [], links: [] } as unknown as NonNullable<Scene['composition']>;
    return scene;
  }
  return { id: 'demo-exit', template: 'close', title: bookends.exit.statement, subtitle: bookends.exit.setup, imageUrl: '', imageAlt: '', items: [] };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'demo';
}

function DemoPage({ bookends, page }: { bookends: DemoBookends; page: Page }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const scene = sceneFor(bookends, page);
  const signature = JSON.stringify(scene);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    const styles = document.createElement('style');
    styles.textContent = css.replaceAll('100vh', '100cqh').replaceAll('position: fixed', 'position: absolute');
    const root = document.createElement('div');
    root.className = 'visual-root';
    const stage = document.createElement('main');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.hidden = true;
    root.append(stage, status);
    shadow.replaceChildren(styles, root);
    try {
      const render = createVisualRenderer(stage, status, root);
      render({ scene, revealed: 0, error: null, presentationTitle: '', page: 0, total: 0, animate: false });
      setError('');
      return () => { render.dispose(); shadow.replaceChildren(); };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This page could not be drawn.');
      return () => { shadow.replaceChildren(); };
    }
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = async (): Promise<void> => {
    const slide = host.current?.shadowRoot?.querySelector<HTMLElement>('.visual-slide');
    if (!slide) { setError('This page is not ready to download yet.'); return; }
    setBusy(true);
    setError('');
    // Entrance animations would be captured mid-flight; the export shows the settled page.
    const motion = ['visual-slide--live', 'visual-slide--motion-paused'].filter(name => slide.classList.contains(name));
    slide.classList.remove(...motion);
    try {
      await document.fonts.ready;
      const url = await toPng(slide, { width: 1600, height: 900, pixelRatio: 1.2, backgroundColor: '#161616', style: { transform: 'none' } });
      const link = document.createElement('a');
      link.href = url;
      link.download = `${slug(bookends.intro.title)}-${page}.png`;
      link.click();
    } catch (err) {
      setError(err instanceof Error && err.message !== '' ? `PNG export failed: ${err.message}` : 'PNG export failed. Try again.');
    } finally {
      slide.classList.add(...motion);
      setBusy(false);
    }
  };

  const label = page === 'intro'
    ? [bookends.intro.label, bookends.intro.title, bookends.intro.subtitle].filter(Boolean).join('. ')
    : [bookends.exit.setup, bookends.exit.statement, 'Thank you', 'White IBM eight-bar logo, lower right'].filter(Boolean).join('. ');

  return (
    <figure className="demo-bookends__page">
      <figcaption className="demo-bookends__caption">{page === 'intro' ? 'Intro page' : 'Exit page'}</figcaption>
      <div ref={host} className="demo-bookends__stage" role="img" aria-label={`${page === 'intro' ? 'Intro' : 'Exit'} page: ${label}`} />
      <div className="demo-bookends__actions">
        <button type="button" className="kh-btn-accent demo-bookends__download" disabled={busy}
          onClick={() => { void download(); }}>
          <Download size={16} aria-hidden="true" />
          {busy ? 'Preparing PNG…' : 'Download PNG (1920×1080)'}
        </button>
      </div>
      {error !== '' && <p className="demo-bookends__error" role="alert">{error}</p>}
    </figure>
  );
}

export function DemoBookendsCard({ bookends }: { bookends: DemoBookends }): React.JSX.Element {
  return (
    <section className="demo-bookends" aria-label="Demo intro and exit pages">
      <DemoPage bookends={bookends} page="intro" />
      <DemoPage bookends={bookends} page="exit" />
    </section>
  );
}
