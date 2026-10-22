import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Close, ZoomIn, ZoomOut, FitToScreen } from '@carbon/icons-react';
import { copyImage, storedImageId } from '../utils/imageClipboard';
import { api } from '../services/api';

export interface ImagePreview { source: string; title: string }

export function ImageViewer({ image, onClose }: { image: ImagePreview; onClose: () => void }): React.ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null);
  useEffect(() => {
    const id = storedImageId(image.source);
    if (!id) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void api.getImageFile(id).then(blob => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setResolved({ source: image.source, url: objectUrl });
    }).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : 'The image could not be loaded.');
    });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [image.source]);
  useEffect(() => {
    const focused = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (focused instanceof HTMLElement && focused.isConnected) focused.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="kh-image-viewer" aria-label={image.title || 'Image viewer'}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => { event.stopPropagation(); }}>
    <header className="kh-image-viewer__toolbar">
      <strong>{image.title || 'Image'}</strong>
      <button type="button" aria-label="Zoom out" disabled={zoom <= 0.25} onClick={() => { setZoom(value => Math.max(0.25, value / 1.25)); }}><ZoomOut /></button>
      <output aria-label="Image zoom">{Math.round(zoom * 100)}%</output>
      <button type="button" aria-label="Zoom in" disabled={zoom >= 8} onClick={() => { setZoom(value => Math.min(8, value * 1.25)); }}><ZoomIn /></button>
      <button type="button" aria-label="Fit image" onClick={() => { setZoom(1); }}><FitToScreen /></button>
      <button type="button" onClick={() => { setError(''); void copyImage(image.source, id => api.getImageFile(id)).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : 'Could not copy image.'); }); }}>Copy image</button>
      <button type="button" autoFocus aria-label="Close image" onClick={onClose}><Close /></button>
    </header>
    {error && <p className="kh-image-viewer__error" role="alert">{error}</p>}
    <div className="kh-image-viewer__scroll">{!storedImageId(image.source) || resolved?.source === image.source ? <img src={resolved?.source === image.source ? resolved.url : image.source} alt={image.title}
      style={{ width: `${zoom * 100}%`, maxWidth: zoom === 1 ? '100%' : 'none', maxHeight: zoom === 1 ? '100%' : 'none' }}
      onError={() => { setError('The image could not be loaded. Close and reopen it to retry.'); }} /> : !error && <p role="status">Loading image...</p>}</div>
  </dialog>, document.body);
}
