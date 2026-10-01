/**
 * components/athena/CompareWithPanel.tsx — "Compare with…": paste another
 * AI's answer (e.g. M365 Copilot) to have Athena compare it with her last
 * answer — what both caught, what only one caught, where they disagree —
 * and write a merged best version.
 */
import React, { useEffect, useRef, useState } from 'react';

interface CompareWithPanelProps {
  onSend: (source: string, answer: string) => void;
  onClose: () => void;
}

const SOURCE_KEY = 'kh_compare_source';

function lastSource(): string {
  try { return window.localStorage.getItem(SOURCE_KEY) ?? 'M365 Copilot'; } catch { return 'M365 Copilot'; }
}

export const CompareWithPanel: React.FC<CompareWithPanelProps> = ({ onSend, onClose }) => {
  const [source, setSource] = useState(lastSource);
  const [answer, setAnswer] = useState('');
  const answerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { answerRef.current?.focus(); }, []);

  return (
    <form
      className="ai-compare"
      onSubmit={(e) => {
        e.preventDefault();
        const name = source.trim() || 'the other AI';
        try { window.localStorage.setItem(SOURCE_KEY, name); } catch { /* storage unavailable */ }
        onSend(name, answer.trim());
      }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="ai-compare__head">
        <span className="ai-compare__title">Compare with</span>
        <input
          className="ai-compare__source"
          value={source}
          onChange={(e) => { setSource(e.target.value); }}
          aria-label="Where the other answer came from"
        />
      </div>
      <textarea
        ref={answerRef}
        className="ai-compare__answer"
        value={answer}
        onChange={(e) => { setAnswer(e.target.value); }}
        placeholder="Paste the other AI's answer here. Athena compares it with her last answer and writes a merged best version."
        rows={6}
        aria-label="The other answer"
      />
      <div className="ai-compare__actions">
        <button type="button" className="ai-output__secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="ai-output__primary" disabled={answer.trim() === ''}>Compare</button>
      </div>
    </form>
  );
};
