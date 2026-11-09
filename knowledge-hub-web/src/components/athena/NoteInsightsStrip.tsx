/**
 * Moment-of-work insight chips above the note-linked Athena panel.
 *
 * When a note opens beside Athena, one cached background check per saved note
 * version may surface up to three findings. Clicking a chip starts a chat turn
 * about it; dismissing hides it for that note version. The strip is silent
 * while the check runs and absent when there is nothing to say.
 */
import { useEffect, useRef, useState } from 'react';
import { Close } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { NoteInsightFinding, NoteInsightsView } from '../../types/ai';

const POLL_MS = 5_000;
const MAX_POLLS = 30;

const KIND_LABELS: Record<NoteInsightFinding['kind'], string> = {
  contradiction: 'Contradiction',
  terminology: 'Terminology',
  stale_reference: 'Stale reference',
  open_question: 'Open question',
};

interface NoteInsightsStripProps {
  noteId: string;
  /** Starts a chat turn about the clicked finding. */
  onOpenFinding: (finding: NoteInsightFinding) => void;
}

export function NoteInsightsStrip({ noteId, onOpenFinding }: NoteInsightsStripProps): React.ReactElement | null {
  const [view, setView] = useState<NoteInsightsView | null>(null);
  const identity = useRef(noteId);
  identity.current = noteId;

  useEffect(() => {
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    setView(null);
    const load = (): void => {
      void api.ensureNoteInsights(noteId).then((result) => {
        if (cancelled || identity.current !== noteId || !result.success) return;
        setView(result.data);
        if (result.data.status === 'pending' && polls < MAX_POLLS) {
          polls += 1;
          timer = setTimeout(load, POLL_MS);
        }
      }).catch(() => undefined); // Insights are an extra; a failed check never disturbs the chat.
    };
    load();
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [noteId]);

  if (view === null || view.status !== 'done') return null;
  const visible = view.findings.filter((finding) => !view.dismissed.includes(finding.id));
  if (visible.length === 0) return null;

  const dismiss = (finding: NoteInsightFinding): void => {
    // Hide immediately; the server records it for this note version.
    setView((current) => current === null ? null : { ...current, dismissed: [...current.dismissed, finding.id] });
    void api.dismissNoteInsight(noteId, view.signature, finding.id).catch(() => undefined);
  };

  return (
    <div className="kh-note-insights" role="region" aria-label="Athena insights on this note">
      {visible.map((finding) => (
        <span key={finding.id} className="kh-note-insights__chip">
          <button
            type="button"
            className="kh-note-insights__open"
            title={finding.detail}
            onClick={() => onOpenFinding(finding)}
          >
            <span className="kh-note-insights__kind">{KIND_LABELS[finding.kind]}</span>
            <span className="kh-note-insights__title">{finding.title}</span>
          </button>
          <button
            type="button"
            className="kh-note-insights__dismiss"
            aria-label={`Dismiss insight: ${finding.title}`}
            onClick={() => dismiss(finding)}
          >
            <Close size={14} />
          </button>
        </span>
      ))}
    </div>
  );
}
