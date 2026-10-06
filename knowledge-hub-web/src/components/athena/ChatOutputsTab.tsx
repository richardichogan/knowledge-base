/**
 * components/athena/ChatOutputsTab.tsx — the Outputs tab of the chat side
 * panel: deliverables Athena saved in this chat (prompts, specs, user
 * stories …), each with its versions. Step through versions, see what
 * changed, edit (your edit becomes a version Athena builds on), copy, or
 * save one to Think.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Copy, Edit, TrashCan, DocumentExport, Checkmark, Code } from '@carbon/icons-react';
import { SendToBuildDialog } from '../../features/build/buildShared';
import { api } from '../../services/api';
import { renderMarkdown } from '../../utils/markdown';
import { sanitizeHtml } from '../../utils/sanitizeHtml';
import { diffLines } from '../../utils/lineDiff';
import { handleCodeCopyClick } from './renderReply';
import { MockupPreview } from './MockupPreview';

interface ChatOutputsTabProps {
  sessionId: string | null;
  /** Bumped when outputs may have changed (after a reply). */
  refreshKey: number;
  /** Show this output (e.g. a reply's "Open" chip); bump `seq` to re-request. */
  focus?: { id: string; seq: number } | undefined;
}

const KIND_LABEL: Record<string, string> = {
  prompt: 'Prompt', spec: 'Spec', stories: 'User stories', screens: 'Screens', script: 'Script', document: 'Document', mockup: 'Mock-up',
};

export const ChatOutputsTab: React.FC<ChatOutputsTabProps> = ({ sessionId, refreshKey, focus }) => {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [buildOutputId, setBuildOutputId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['chat-outputs', sessionId, refreshKey],
    queryFn: async () => {
      if (sessionId === null) return [];
      const r = await api.listChatOutputs(sessionId);
      return r.success ? r.data : [];
    },
  });
  const outputs = useMemo(() => list.data ?? [], [list.data]);

  useEffect(() => {
    if (focus === undefined) return;
    setSelectedId(focus.id);
    setViewVersion(null);
    setDraft(null);
  }, [focus?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default to the most recently changed output; drop a selection that no longer exists.
  const activeId = selectedId !== null && outputs.some((o) => o.id === selectedId) ? selectedId : outputs[0]?.id ?? null;

  const detail = useQuery({
    queryKey: ['chat-output', activeId, refreshKey, outputs.find((o) => o.id === activeId)?.version],
    queryFn: async () => {
      if (activeId === null) return null;
      const r = await api.getChatOutput(activeId);
      return r.success ? r.data : null;
    },
    enabled: activeId !== null,
  });
  const output = detail.data ?? null;
  const latest = output?.versions[output.versions.length - 1];
  const shown = output?.versions.find((v) => v.version === viewVersion) ?? latest;
  const previous = output !== null && shown !== undefined ? output.versions.find((v) => v.version === shown.version - 1) : undefined;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['chat-outputs', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['chat-output', activeId] });
  };
  const flash = (text: string): void => {
    setNotice(text);
    window.setTimeout(() => { setNotice(null); }, 2500);
  };

  if (sessionId === null || (!list.isLoading && outputs.length === 0)) {
    return (
      <div className="ai-panel-empty">
        Deliverables Athena writes in this chat — prompts, specs, user stories, demo scripts — appear here, with every
        version, so you can compare, edit and copy them.
      </div>
    );
  }
  if (list.isLoading) return <InlineLoading description="Loading outputs…" />;

  return (
    <div className="ai-outputs">
      {outputs.length > 1 && (
        <ul className="ai-outputs__list" aria-label="Outputs in this chat">
          {outputs.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className={`ai-outputs__item${o.id === activeId ? ' ai-outputs__item--active' : ''}`}
                onClick={() => { setSelectedId(o.id); setViewVersion(null); setShowChanges(false); setDraft(null); }}
              >
                <span className="ai-outputs__item-title">{o.title}</span>
                <span className="ai-outputs__item-meta">{KIND_LABEL[o.kind] ?? o.kind} · v{o.version}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {output === null || shown === undefined ? (
        <InlineLoading description="Loading…" />
      ) : (
        <div className="ai-output">
          <div className="ai-output__head">
            <h3 className="ai-output__title">{output.title}</h3>
            <span className="ai-output__kind">{KIND_LABEL[output.kind] ?? output.kind}</span>
          </div>

          <div className="ai-output__bar">
            <label className="ai-output__version">
              <span className="cds--visually-hidden">Version</span>
              <select
                value={shown.version}
                onChange={(e) => { setViewVersion(Number(e.target.value)); setDraft(null); }}
              >
                {[...output.versions].reverse().map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}{v.author === 'user' ? ' (your edit)' : ''}{v.version === latest?.version ? ' — latest' : ''}
                  </option>
                ))}
              </select>
            </label>
            {output.format === 'html' && (
              <label className="ai-output__changes">
                <input type="checkbox" checked={showCode} onChange={(e) => { setShowCode(e.target.checked); }} />
                Code
              </label>
            )}
            <label className={`ai-output__changes${previous === undefined ? ' ai-output__changes--off' : ''}`}>
              <input
                type="checkbox"
                checked={showChanges && previous !== undefined}
                disabled={previous === undefined}
                onChange={(e) => { setShowChanges(e.target.checked); }}
              />
              Show changes
            </label>
            <span className="ai-output__actions">
              <button
                type="button" className="ai-output__btn" title="Copy"
                onClick={() => { void navigator.clipboard.writeText(shown.content).then(() => { flash('Copied'); }); }}
              >
                <Copy size={16} aria-hidden="true" /><span className="cds--visually-hidden">Copy</span>
              </button>
              <button type="button" className="ai-output__btn" title="Edit" onClick={() => { setDraft(shown.content); }}>
                <Edit size={16} aria-hidden="true" /><span className="cds--visually-hidden">Edit</span>
              </button>
              <button
                type="button" className="ai-output__btn" title="Save to Think"
                onClick={() => {
                  void api.saveChatOutputToThink(output.id, shown.version).then((r) => {
                    flash(r.success ? 'Saved to Think' : 'Could not save to Think');
                  });
                }}
              >
                <DocumentExport size={16} aria-hidden="true" /><span className="cds--visually-hidden">Save to Think</span>
              </button>
              {output.format === 'markdown' && (
                <button
                  type="button" className="ai-output__btn" title="Send to Build (GitHub coding agents)"
                  onClick={() => { setBuildOutputId(output.id); }}
                >
                  <Code size={16} aria-hidden="true" /><span className="cds--visually-hidden">Send to Build</span>
                </button>
              )}
              <button
                type="button" className="ai-output__btn ai-output__btn--danger" title="Delete"
                onClick={() => {
                  if (!window.confirm(`Delete "${output.title}" and all its versions?`)) return;
                  void api.deleteChatOutput(output.id).then(() => { setSelectedId(null); refresh(); });
                }}
              >
                <TrashCan size={16} aria-hidden="true" /><span className="cds--visually-hidden">Delete</span>
              </button>
            </span>
          </div>

          {notice !== null && <div className="ai-output__notice" role="status"><Checkmark size={14} aria-hidden="true" /> {notice}</div>}
          <p className="ai-output__meta">
            v{shown.version} · {shown.author === 'user' ? 'your edit' : 'Athena'} · {new Date(shown.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {shown.note !== null && shown.note !== '' && <> · {shown.note}</>}
          </p>

          {draft !== null ? (
            <div className="ai-output__edit">
              <textarea
                className="ai-output__textarea"
                value={draft}
                onChange={(e) => { setDraft(e.target.value); }}
                aria-label="Edit output"
              />
              <div className="ai-output__edit-actions">
                <button
                  type="button" className="ai-output__primary"
                  disabled={draft.trim() === '' || draft === shown.content}
                  onClick={() => {
                    void api.addChatOutputVersion(output.id, draft).then((r) => {
                      if (!r.success) { flash('Could not save'); return; }
                      setDraft(null);
                      setViewVersion(null);
                      refresh();
                      flash(`Saved as v${r.data.version.toString()}`);
                    });
                  }}
                >
                  Save as new version
                </button>
                <button type="button" className="ai-output__secondary" onClick={() => { setDraft(null); }}>Cancel</button>
              </div>
            </div>
          ) : showChanges && previous !== undefined ? (
            <pre className="ai-diff" aria-label={`Changes from v${previous.version.toString()} to v${shown.version.toString()}`}>
              {diffLines(previous.content, shown.content).map((l, i) => (
                <div key={i} className={`ai-diff__line ai-diff__line--${l.type}`}>
                  <span className="ai-diff__mark" aria-hidden="true">{l.type === 'added' ? '+' : l.type === 'removed' ? '−' : ' '}</span>
                  {l.text === '' ? ' ' : l.text}
                </div>
              ))}
            </pre>
          ) : output.format === 'html' && !showCode ? (
            <MockupPreview key={`${output.id}-${shown.version.toString()}`} html={shown.content} title={output.title} />
          ) : output.format !== 'markdown' ? (
            <pre className="ai-output__pre">{shown.content}</pre>
          ) : (
            <div
              className="ai-output__md ai-bubble-text--md"
              onClick={handleCodeCopyClick}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderMarkdown(shown.content)) }}
            />
          )}
        </div>
      )}
      {buildOutputId !== null && (
        <SendToBuildDialog source={{ kind: 'output', outputId: buildOutputId }} onClose={() => { setBuildOutputId(null); }} />
      )}
    </div>
  );
};
