/**
 * components/athena/ChatScreensTab.tsx — the Screens tab of the chat side
 * panel: screenshots kept with this chat. Name them as journey steps, put
 * them in order, mark up areas, then "Review this journey" (Athena looks at
 * the screens together, focusing on what should change between steps) or
 * ask about the areas marked on one screen.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { ArrowUp, ArrowDown, TrashCan, Edit, Close } from '@carbon/icons-react';
import { api } from '../../services/api';
import { confirmDialog } from '../../services/appDialogs';
import type { ChatScreen } from '../../types';
import { ScreenMarkup } from './ScreenMarkup';

interface ChatScreensTabProps {
  sessionId: string | null;
  refreshKey: number;
  /** A reply is being worked on — reviews wait for it. */
  busy: boolean;
  onReviewJourney: (question: string) => void;
  onAskAboutMarked: (screen: ChatScreen) => void;
}

/** The screenshot (or its marked-up copy), fetched with sign-in. */
function useScreenImage(screen: ChatScreen, annotated: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void api.fetchChatScreenImage(screen.id, annotated).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => { /* placeholder stays */ });
    return () => { cancelled = true; if (objectUrl !== null) URL.revokeObjectURL(objectUrl); };
  }, [screen.id, annotated, screen.annotationNote]);
  return url;
}

const ScreenCard: React.FC<{
  screen: ChatScreen; index: number; count: number; busy: boolean;
  onMove: (dir: -1 | 1) => void; onChanged: () => void; onMarkup: (originalUrl: string) => void; onAsk: () => void;
}> = ({ screen, index, count, busy, onMove, onChanged, onMarkup, onAsk }) => {
  const shown = useScreenImage(screen, screen.annotated);
  const original = useScreenImage(screen, false);
  const [name, setName] = useState(screen.name);
  useEffect(() => { setName(screen.name); }, [screen.name]);

  return (
    <li className={`ai-screen${screen.inJourney ? '' : ' ai-screen--out'}`}>
      <div className="ai-screen__top">
        <span className="ai-screen__step">{index + 1}</span>
        <input
          className="ai-screen__name"
          value={name}
          aria-label="Step name"
          onChange={(e) => { setName(e.target.value); }}
          onBlur={() => { if (name.trim() !== '' && name !== screen.name) void api.updateChatScreen(screen.id, { name }).then(onChanged); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <button type="button" className="ai-decision__btn" title="Move up" disabled={index === 0} onClick={() => { onMove(-1); }}>
          <ArrowUp size={14} aria-hidden="true" /><span className="cds--visually-hidden">Move up</span>
        </button>
        <button type="button" className="ai-decision__btn" title="Move down" disabled={index === count - 1} onClick={() => { onMove(1); }}>
          <ArrowDown size={14} aria-hidden="true" /><span className="cds--visually-hidden">Move down</span>
        </button>
        <button
          type="button" className="ai-decision__btn" title="Delete screenshot"
          onClick={async () => { if (await confirmDialog(`Delete "${screen.name}" from this chat?`, { title: 'Delete screenshot', confirmLabel: 'Delete', tone: 'danger' })) void api.deleteChatScreen(screen.id).then(onChanged); }}
        >
          <TrashCan size={14} aria-hidden="true" /><span className="cds--visually-hidden">Delete</span>
        </button>
      </div>
      <button
        type="button"
        className="ai-screen__thumb"
        title="Mark up areas on this screen"
        disabled={original === null}
        onClick={() => { if (original !== null) onMarkup(original); }}
      >
        {shown !== null ? <img src={shown} alt={screen.name} /> : <InlineLoading description="Loading…" />}
      </button>
      {screen.annotationNote !== null && <p className="ai-screen__note">Your note: {screen.annotationNote}</p>}
      <div className="ai-screen__actions">
        <label className="ai-screen__journey">
          <input
            type="checkbox"
            checked={screen.inJourney}
            onChange={(e) => { void api.updateChatScreen(screen.id, { inJourney: e.target.checked }).then(onChanged); }}
          />
          In journey
        </label>
        <button type="button" className="ai-screen__link" disabled={original === null} onClick={() => { if (original !== null) onMarkup(original); }}>
          <Edit size={14} aria-hidden="true" /> {screen.annotated ? 'Redo mark-up' : 'Mark up'}
        </button>
        {screen.annotated && (
          <>
            <button type="button" className="ai-screen__link" disabled={busy} onClick={onAsk}>Ask about the marked areas</button>
            <button type="button" className="ai-screen__link ai-screen__link--quiet" onClick={() => { void api.clearScreenAnnotation(screen.id).then(onChanged); }}>
              <Close size={14} aria-hidden="true" /> Remove mark-up
            </button>
          </>
        )}
      </div>
    </li>
  );
};

export const ChatScreensTab: React.FC<ChatScreensTabProps> = ({ sessionId, refreshKey, busy, onReviewJourney, onAskAboutMarked }) => {
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState('');
  const [markup, setMarkup] = useState<{ screen: ChatScreen; url: string } | null>(null);

  const query = useQuery({
    queryKey: ['chat-screens', sessionId, refreshKey],
    queryFn: async () => {
      if (sessionId === null) return [];
      const r = await api.listChatScreens(sessionId);
      return r.success ? r.data : [];
    },
  });
  const screens = useMemo(() => query.data ?? [], [query.data]);
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['chat-screens', sessionId] }); };
  const journeyCount = screens.filter((s) => s.inJourney).length;

  if (sessionId === null || (!query.isLoading && screens.length === 0)) {
    return (
      <div className="ai-panel-empty">
        Screenshots you paste into this chat are kept here. Name them as steps, put them in order and “Review this
        journey” to have Athena look at them together — or mark up an area and ask about it.
      </div>
    );
  }
  if (query.isLoading) return <InlineLoading description="Loading screens…" />;

  const move = (index: number, dir: -1 | 1): void => {
    const ids = screens.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + dir, 0, moved!);
    void api.reorderChatScreens(sessionId, ids).then(refresh);
  };

  return (
    <div className="ai-screens">
      <ol className="ai-screens__list">
        {screens.map((s, i) => (
          <ScreenCard
            key={s.id}
            screen={s}
            index={i}
            count={screens.length}
            busy={busy}
            onMove={(dir) => { move(i, dir); }}
            onChanged={refresh}
            onMarkup={(url) => { setMarkup({ screen: s, url }); }}
            onAsk={() => { onAskAboutMarked(s); }}
          />
        ))}
      </ol>

      <form
        className="ai-screens__review"
        onSubmit={(e) => {
          e.preventDefault();
          onReviewJourney(question);
          setQuestion('');
        }}
      >
        <input
          value={question}
          onChange={(e) => { setQuestion(e.target.value); }}
          placeholder="Anything in particular? (optional)"
          aria-label="Question for the journey review"
        />
        <button type="submit" className="ai-output__primary" disabled={busy || journeyCount < 2}>
          Review this journey ({journeyCount} screens)
        </button>
        {journeyCount < 2 && <span className="ai-screens__hint">Needs at least two screens in the journey.</span>}
      </form>

      {markup !== null && (
        <ScreenMarkup
          screenId={markup.screen.id}
          name={markup.screen.name}
          imageUrl={markup.url}
          initialNote={markup.screen.annotationNote ?? ''}
          onClose={() => { setMarkup(null); }}
          onSaved={refresh}
        />
      )}
    </div>
  );
};
