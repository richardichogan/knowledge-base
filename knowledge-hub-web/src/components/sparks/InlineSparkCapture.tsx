/**
 * components/sparks/InlineSparkCapture.tsx
 * Inline text input that expands below a Discover card action row.
 * Source item tags pre-populate; submits on Enter or send button.
 */
import React, { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

interface InlineSparkCaptureProps {
  sourceId: string;
  sourceType: string;
  /** Tag names from the source item for pre-population. */
  initialTags?: string[];
  onClose: () => void;
}

export const InlineSparkCapture: React.FC<InlineSparkCaptureProps> = ({
  sourceId, sourceType, initialTags = [], onClose,
}) => {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); };
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: () => api.createSpark({
      body: body.trim(),
      tags: initialTags,
      source_id: sourceId,
      source_type: sourceType,
    }),
    onSuccess: (res) => {
      if (res.success !== true) { setError('Failed to save'); return; }
      void qc.invalidateQueries({ queryKey: ['sparks'] });
      onClose();
    },
    onError: (err: unknown) => { setError(err instanceof Error ? err.message : 'Network error'); },
  });

  const submit = (): void => { if (body.trim() !== '') mutation.mutate(); };

  return (
    <div className="isc-wrap">
      <input
        ref={inputRef}
        className="isc-input"
        placeholder="Capture a thought about this…"
        value={body}
        onChange={(e) => { setBody(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        disabled={mutation.isPending}
      />
      <button className="isc-send-btn" onClick={submit} disabled={body.trim() === '' || mutation.isPending}>
        {mutation.isPending ? '…' : '↵'}
      </button>
      {error !== null && <span className="isc-error">{error}</span>}
    </div>
  );
};
