import React, { useEffect, useId, useRef } from 'react';
import { AthenaRibbon } from './AthenaRibbon';

const FOLD = 'M37 139 L95 62 L126 62 L132 70 L138 62 L189 62 L132 139 L101 139 L95 131 L89 139 Z';

export const BackgroundActivityMark: React.FC<{ iris?: boolean }> = ({ iris = false }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let visible = true;
    const update = (): void => {
      const paused = document.hidden || !visible;
      element.classList.toggle('ai-work-mark--paused', paused);
      element.querySelector('athena-ribbon')?.toggleAttribute('paused', paused);
    };
    const observer = new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, [iris]);
  return <span ref={ref} className="ai-work-mark" aria-hidden="true">
    {iris ? <svg viewBox="0 0 240 240" focusable="false">
      <defs>
        <linearGradient id={`${id}-back`} x1="0" x2="1" y1="0" y2="1">
          <stop stopColor="#be95ff" stopOpacity=".48" /><stop offset="1" stopColor="#6f5b96" stopOpacity=".2" />
        </linearGradient>
        <linearGradient id={`${id}-front`} x1="0" x2="1" y1="0" y2="1">
          <stop stopColor="#d0b9ff" stopOpacity=".72" /><stop offset="1" stopColor="#67518e" stopOpacity=".38" />
        </linearGradient>
      </defs>
      <g className="ai-work-mark__fold ai-work-mark__back"><path d={FOLD} fill={`url(#${id}-back)`} stroke="#a6c8ff" strokeOpacity=".65" strokeWidth="1.5" /></g>
      <g className="ai-work-mark__fold"><path d={FOLD} fill="#9e79d1" fillOpacity=".36" stroke="#a6c8ff" strokeOpacity=".72" strokeWidth="1.5" /></g>
      <g className="ai-work-mark__fold ai-work-mark__front"><path d={FOLD} fill={`url(#${id}-front)`} stroke="#a6c8ff" strokeWidth="1.5" /></g>
      <path className="ai-work-mark__seam" d="M96 131 L132 70" fill="none" stroke="#a6c8ff" strokeWidth="2.5" strokeLinecap="round" />
    </svg> : <AthenaRibbon mood="thinking" size={56} />}
  </span>;
};
