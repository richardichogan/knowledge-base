/**
 * components/athena/ScreenMarkup.tsx — draw numbered boxes on a screenshot
 * and add a note ("this button should change after submit"). Saves a copy
 * with the boxes drawn on, which Athena looks at when asked about it.
 */
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';

interface Box { x: number; y: number; w: number; h: number }

interface ScreenMarkupProps {
  screenId: string;
  name: string;
  /** Object URL of the original screenshot. */
  imageUrl: string;
  initialNote: string;
  onClose: () => void;
  onSaved: () => void;
}

const MARK_COLOUR = '#ff832b';

/** The screenshot with the boxes and their numbers drawn on, as a PNG. */
async function composite(imageUrl: string, boxes: Box[]): Promise<Blob> {
  const img = new Image();
  img.src = imageUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Canvas unavailable');
  ctx.drawImage(img, 0, 0);
  const line = Math.max(3, Math.round(canvas.width / 320));
  const radius = Math.max(12, Math.round(canvas.width / 90));
  boxes.forEach((b, i) => {
    const x = b.x * canvas.width;
    const y = b.y * canvas.height;
    const w = b.w * canvas.width;
    const h = b.h * canvas.height;
    ctx.fillStyle = 'rgba(255, 131, 43, 0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = MARK_COLOUR;
    ctx.lineWidth = line;
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = MARK_COLOUR;
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = `bold ${Math.round(radius * 1.2).toString()}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x, y);
  });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob !== null) resolve(blob); else reject(new Error('Could not create the image')); }, 'image/png');
  });
}

export const ScreenMarkup: React.FC<ScreenMarkupProps> = ({ screenId, name, imageUrl, initialNote, onClose, onSaved }) => {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [draft, setDraft] = useState<Box | null>(null);
  const [note, setNote] = useState(initialNote);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const r = areaRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const boxFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Box =>
    ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  const save = (): void => {
    setSaving(true);
    setError(null);
    void composite(imageUrl, boxes)
      .then((png) => api.saveScreenAnnotation(screenId, png, note))
      .then(() => { onSaved(); onClose(); })
      .catch(() => { setError('Couldn’t save the marked-up screen.'); setSaving(false); });
  };

  return (
    <div className="ai-markup" role="dialog" aria-modal="true" aria-label={`Mark up ${name}`}>
      <div className="ai-markup__panel">
        <div className="ai-markup__head">
          <h3 className="ai-markup__title">Mark up: {name}</h3>
          <span className="ai-markup__hint">Drag to draw a box around each area you want looked at.</span>
        </div>
        <div className="ai-markup__stage">
          <div
            ref={areaRef}
            className="ai-markup__area"
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              startRef.current = point(e);
              setDraft({ ...startRef.current, w: 0, h: 0 });
            }}
            onPointerMove={(e) => { if (startRef.current !== null) setDraft(boxFrom(startRef.current, point(e))); }}
            onPointerUp={(e) => {
              if (startRef.current === null) return;
              const b = boxFrom(startRef.current, point(e));
              startRef.current = null;
              setDraft(null);
              if (b.w > 0.01 && b.h > 0.01) setBoxes((list) => [...list, b]);
            }}
          >
            <img src={imageUrl} alt={name} className="ai-markup__img" draggable={false} />
            {[...boxes, ...(draft !== null ? [draft] : [])].map((b, i) => (
              <div
                key={i}
                className="ai-markup__box"
                style={{ left: `${(b.x * 100).toString()}%`, top: `${(b.y * 100).toString()}%`, width: `${(b.w * 100).toString()}%`, height: `${(b.h * 100).toString()}%` }}
              >
                {i < boxes.length && <span className="ai-markup__num">{i + 1}</span>}
              </div>
            ))}
          </div>
        </div>
        <label className="ai-markup__note">
          What should Athena look at? (optional)
          <textarea
            value={note}
            onChange={(e) => { setNote(e.target.value); }}
            placeholder="e.g. 1 should change to “Submitted” after I click Submit; 2 still says I own the next step."
            rows={3}
          />
        </label>
        {error !== null && <p className="ai-markup__error" role="alert">{error}</p>}
        <div className="ai-markup__actions">
          <button type="button" className="ai-output__secondary" disabled={boxes.length === 0} onClick={() => { setBoxes((l) => l.slice(0, -1)); }}>Undo box</button>
          <button type="button" className="ai-output__secondary" disabled={boxes.length === 0} onClick={() => { setBoxes([]); }}>Clear</button>
          <span className="ai-markup__spacer" />
          <button type="button" className="ai-output__secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="ai-output__primary" disabled={saving || (boxes.length === 0 && note.trim() === '')} onClick={save}>
            {saving ? 'Saving…' : 'Save mark-up'}
          </button>
        </div>
      </div>
    </div>
  );
};
