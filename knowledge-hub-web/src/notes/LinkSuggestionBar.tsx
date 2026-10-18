import React, { useEffect, useRef, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { ENTITY_LINK_LABELS, type EntityLinkTarget } from './entityLinks';
import type { editorSchema } from './editorSchema';

type Editor = BlockNoteEditor<typeof editorSchema.blockSchema, typeof editorSchema.inlineContentSchema, typeof editorSchema.styleSchema>;
interface TextRun { text: string; from: number }
interface Match { from: number; to: number }
interface Suggestion { target: EntityLinkTarget; matches: Match[] }
const HIGHLIGHT = 'kh-link-suggest';
const IDLE_MS = 800;

function targetKey(target: EntityLinkTarget): string { return `${target.type}:${target.id}`; }
function phraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[\\[${escaped}\\]\\]|(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
}

function textRuns(editor: Editor): TextRun[] {
  const runs: TextRun[] = [];
  editor._tiptapEditor.state.doc.descendants((node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    let run: TextRun | undefined;
    node.forEach((child, offset) => {
      if (!child.isText || child.marks.some(mark => mark.type.name === 'link' || mark.type.name === 'code')) {
        run = undefined;
      } else if (run) {
        run.text += child.text ?? '';
      } else {
        run = { text: child.text ?? '', from: pos + 1 + offset };
        runs.push(run);
      }
    });
    return false;
  });
  return runs;
}

function matchesFor(editor: Editor, phrase: string): Match[] {
  return textRuns(editor).flatMap(run => [...run.text.matchAll(phraseRegex(phrase))]
    .map(match => ({ from: run.from + match.index, to: run.from + match.index + match[0].length })));
}

function linkOccurrences(editor: Editor, target: EntityLinkTarget, all: boolean): void {
  if (!editor.isEditable) return;
  const matches = matchesFor(editor, target.title);
  const selected = all ? matches : matches.slice(0, 1);
  const { state, view } = editor._tiptapEditor;
  const nodeType = state.schema.nodes[target.type === 'note' ? 'noteMention' : 'entityMention'];
  if (!nodeType) throw new Error('The editor does not support this link type.');
  const attrs = target.type === 'note' ? { noteId: target.id } : { entityType: target.type, entityId: target.id };
  const transaction = state.tr;
  // Work backwards so earlier positions stay valid; a single Undo removes this action.
  for (const match of [...selected].reverse()) {
    transaction.replaceWith(match.from, match.to, nodeType.createChecked(attrs, undefined, state.doc.resolve(match.from).marks()));
  }
  if (selected.length) view.dispatch(transaction);
}

function highlightMatches(editor: Editor, suggestions: Suggestion[]): () => void {
  const css = CSS as typeof CSS & { highlights?: Map<string, unknown> };
  const browser = window as Window & { Highlight?: new (...ranges: Range[]) => unknown };
  const registry = css.highlights;
  if (!registry || !browser.Highlight) return () => {};
  const ranges = suggestions.flatMap(s => s.matches).map(match => {
    const from = editor._tiptapEditor.view.domAtPos(match.from);
    const to = editor._tiptapEditor.view.domAtPos(match.to);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  });
  registry.set(HIGHLIGHT, new browser.Highlight(...ranges));
  return () => { registry.delete(HIGHLIGHT); };
}

export function LinkSuggestionBar({ editor, noteId, disabled }: {
  editor: Editor; noteId: string; disabled?: boolean;
}): React.ReactElement | null {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const dismissed = useRef(new Set<string>());

  useEffect(() => {
    if (disabled) return;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const current = ++generation;
      clearTimeout(timer);
      setSuggestions([]);
      timer = setTimeout(() => {
        const writing = textRuns(editor).map(run => run.text).join('\n');
        if (!writing.trim()) { setError(null); return; }
        void api.suggestLinkTargets(writing, noteId).then(requireApiData).then(targets => {
          if (current !== generation) return;
          setError(null);
          setSuggestions(targets.filter(t => !dismissed.current.has(targetKey(t)))
            .map(target => ({ target, matches: matchesFor(editor, target.title) }))
            .filter(s => s.matches.length > 0));
        }).catch((reason: unknown) => {
          if (current !== generation) return;
          console.error('[note links] Suggestions unavailable:', reason);
          setError('Link suggestions could not load. Your writing is unchanged.');
        });
      }, IDLE_MS);
    };
    schedule();
    const unsubscribe = editor.onChange(schedule);
    return () => { generation++; clearTimeout(timer); unsubscribe(); };
  }, [editor, noteId, disabled, retry]);

  useEffect(() => {
    if (disabled) return;
    return highlightMatches(editor, suggestions);
  }, [editor, suggestions, disabled]);

  if (disabled || (!suggestions.length && !error)) return null;
  return <div className="note-link-suggest" role="region" aria-label="Unlinked mentions">
    {error && <span role="alert">{error} <button type="button" onClick={() => { setRetry(value => value + 1); }}>Retry</button></span>}
    {suggestions.length > 0 && <span className="note-link-suggest__label">Unlinked mentions</span>}
    {suggestions.map(({ target, matches }) => <span key={targetKey(target)} className="note-link-suggest__item">
      <span><strong>{target.title}</strong> · {ENTITY_LINK_LABELS[target.type]} · {matches.length}×</span>
      <button type="button" onClick={() => { linkOccurrences(editor, target, false); }}>Link</button>
      {matches.length > 1 && <button type="button" onClick={() => { linkOccurrences(editor, target, true); }}>Link all</button>}
      <button type="button" aria-label={`Dismiss ${ENTITY_LINK_LABELS[target.type]} ${target.title}`} onClick={() => {
        dismissed.current.add(targetKey(target));
        setSuggestions(previous => previous.filter(s => targetKey(s.target) !== targetKey(target)));
      }}>Dismiss</button>
    </span>)}
  </div>;
}
