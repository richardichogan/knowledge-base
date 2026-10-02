/**
 * components/athena/MockupPreview.tsx — shows an HTML mock-up Athena saved
 * as an Output, rendered at a chosen device width and scaled to fit the
 * panel. The page runs in a sealed frame (scripts allowed, but in its own
 * opaque origin: it can't reach the app, its sign-in or its data).
 */
import React, { useEffect, useRef, useState } from 'react';

const DEVICES = {
  desktop: { label: 'Desktop', width: 1280, height: 800 },
  tablet: { label: 'Tablet', width: 820, height: 1100 },
  mobile: { label: 'Mobile', width: 390, height: 844 },
} as const;
type Device = keyof typeof DEVICES;

const DEVICE_KEY = 'kh_mockup_device';

function savedDevice(): Device {
  try {
    const v = window.localStorage.getItem(DEVICE_KEY);
    return v === 'tablet' || v === 'mobile' ? v : 'desktop';
  } catch { return 'desktop'; }
}

/** Opens the mock-up full size in a new tab, still inside a sealed frame. */
export function openMockupFullSize(html: string, title: string): void {
  const w = window.open('', '_blank');
  if (w === null) return;
  w.document.title = title;
  w.document.body.style.margin = '0';
  const frame = w.document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.cssText = 'border:0;width:100vw;height:100vh;display:block';
  frame.srcdoc = html;
  w.document.body.appendChild(frame);
}

export const MockupPreview: React.FC<{ html: string; title: string }> = ({ html, title }) => {
  const [device, setDevice] = useState<Device>(savedDevice);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (el === null) return undefined;
    const observer = new ResizeObserver(() => { setBoxWidth(el.clientWidth); });
    observer.observe(el);
    setBoxWidth(el.clientWidth);
    return () => { observer.disconnect(); };
  }, []);

  const spec = DEVICES[device];
  const scale = boxWidth > 0 ? Math.min(1, boxWidth / spec.width) : 1;

  return (
    <div className="ai-mockup">
      <div className="ai-mockup__bar" role="group" aria-label="Preview width">
        {(Object.keys(DEVICES) as Device[]).map((d) => (
          <button
            key={d}
            type="button"
            className={`ai-mockup__device${d === device ? ' ai-mockup__device--on' : ''}`}
            aria-pressed={d === device}
            onClick={() => { setDevice(d); try { window.localStorage.setItem(DEVICE_KEY, d); } catch { /* storage unavailable */ } }}
          >
            {DEVICES[d].label}
          </button>
        ))}
        <button type="button" className="ai-mockup__open" onClick={() => { openMockupFullSize(html, title); }}>Open full size</button>
      </div>
      <div ref={boxRef} className="ai-mockup__stage" style={{ height: `${Math.round(spec.height * scale).toString()}px` }}>
        <iframe
          title={`${title} — ${spec.label} preview`}
          className="ai-mockup__frame"
          sandbox="allow-scripts"
          srcDoc={html}
          style={{ width: `${spec.width.toString()}px`, height: `${spec.height.toString()}px`, transform: `scale(${scale.toString()})` }}
        />
      </div>
    </div>
  );
};
