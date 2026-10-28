/**
 * GlobalContextMenu — app-wide right-click menu.
 *
 * Triggers on ANY right-click. Priority:
 *  0. Misspelled word right-clicked in editable text (en-GB dictionary) → spelling menu
 *  1. Element with data-ctx-title → structured item
 *  2. <img> element               → image node
 *  3. Text selection              → text node
 *  4. <a href> ancestor           → link node
 *  5. Passthrough to browser (Shift+right-click always passes through)
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '@carbon/react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Checkmark, Diagram, Link, Copy, TaskAdd, Idea, DocumentAdd, ChatBot, ArrowRight, Rocket, Image as ImageIcon } from '@carbon/icons-react';
import { useAthenaContext } from './AthenaContext';
import { UseCaseLauncher, type UseCaseLaunch } from '../features/useCases/UseCaseLauncher';
import { launchFromRef } from '../features/useCases/useCaseView';
import { createNote } from '../notes/noteStorage';
import type { NoteExtractionAction } from '../services/api';
import { api } from '../services/api';
import type { CanvasSummaryApi } from '../services/api';
import { extractTasksWithAI } from '../utils/aiTaskExtraction';
import { addWorkingDays, toISODateString } from '../utils/dates';
import { getActiveBlockNoteSelectedText, clearActiveBlockNoteSelectionSnapshot, suspendBlockNoteSelectionCapture, resumeBlockNoteSelectionCapture, hasBlockNoteCellSelection, getActiveBlockNoteEditor, capturePassageSelection, applyPassageTag, type PassageSelection } from '../utils/activeBlockNoteEditor';
import { PASSAGE_TAGS, type PassageTag } from '../notes/passageTags';
import { isMisspelled, isSpellableWord, loadSpelling, spellingSuggestions } from '../utils/spelling';
import { copyImage } from '../utils/imageClipboard';
import { ImageViewer, type ImagePreview } from '../components/ImageViewer';
import { ContactCapture } from '../components/ContactCapture';

export interface CtxItemData {
  title: string;
  body?: string | undefined;
  source?: string | undefined;
  url?: string | undefined;
  imageUrl?: string | undefined;
  nodeType?: string | undefined;
  refId?: string | undefined;
  refType?: string | undefined;
  tags?: string[] | undefined;
  taxonomyTagIds?: string[] | undefined;
  /** True when `body` is text the user selected (as opposed to a card's summary). */
  fromSelection?: boolean | undefined;
  /** Selection made inside an Athena chat (no Discuss action there). */
  fromChat?: boolean | undefined;
  passageSelection?: PassageSelection | undefined;
}

interface MenuState { x: number; y: number; item: CtxItemData; }
interface GlobalCtxMenuCtx { openMenu: (e: MouseEvent | React.MouseEvent, item: CtxItemData) => void; }

const Ctx = createContext<GlobalCtxMenuCtx>({ openMenu: () => {} });

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
// How long after a native right-click the browser's own word selection may arrive.
const BROWSER_WORD_WINDOW_MS = 1500;
interface SelectionRange { startNode: Node; startOffset: number; endNode: Node; endOffset: number }
function currentSelectionRange(): SelectionRange | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return { startNode: range.startContainer, startOffset: range.startOffset, endNode: range.endContainer, endOffset: range.endOffset };
}
function sameSelectionRange(a: SelectionRange, b: SelectionRange | null): boolean {
  return b !== null && a.startNode === b.startNode && a.startOffset === b.startOffset
    && a.endNode === b.endNode && a.endOffset === b.endOffset;
}
export function useGlobalContextMenu() { return useContext(Ctx); }

/** A misspelled word the user right-clicked, shown in Athena's spelling menu. */
type SpellTarget =
  | { kind: 'field'; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number; word: string }
  | { kind: 'rich'; root: HTMLElement; range: Range; word: string };
interface SpellMenuState { x: number; y: number; edit: EditTarget; spelling: SpellTarget | null }

/** Where Cut/Copy/Paste act: a text field's selection, or a rich-text range (possibly collapsed). */
type EditTarget =
  | { kind: 'field'; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number }
  | { kind: 'rich'; root: HTMLElement; range: Range };

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', '']);

function caretRangeAtPoint(x: number, y: number): Range | null {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  const position = (document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

function textField(target: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  const field = target.closest('input, textarea');
  return field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(field.type)) ? field : null;
}

function editTargetAt(target: HTMLElement, x: number, y: number): EditTarget | null {
  const field = textField(target);
  if (field) {
    if (field.disabled || field.selectionStart === null) return null;
    return { kind: 'field', el: field, start: field.selectionStart, end: field.selectionEnd ?? field.selectionStart };
  }
  const root = target.closest<HTMLElement>('[contenteditable="true"]');
  if (!root) return null;
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed && root.contains(selection.getRangeAt(0).commonAncestorContainer)) {
    return { kind: 'rich', root, range: selection.getRangeAt(0).cloneRange() };
  }
  const caret = caretRangeAtPoint(x, y);
  if (caret && root.contains(caret.startContainer)) return { kind: 'rich', root, range: caret };
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return { kind: 'rich', root, range };
}
const WORD_CHAR = /[\p{L}\p{M}'’-]/u;

/** Expands `[at, at]` in `text` to the surrounding word, trimming edge apostrophes/hyphens. */
function wordBounds(text: string, at: number): { start: number; end: number } | null {
  let start = at;
  let end = at;
  while (start > 0 && WORD_CHAR.test(text.charAt(start - 1))) start--;
  while (end < text.length && WORD_CHAR.test(text.charAt(end))) end++;
  while (start < end && /['’-]/.test(text.charAt(start))) start++;
  while (end > start && /['’-]/.test(text.charAt(end - 1))) end--;
  return end > start && isSpellableWord(text.slice(start, end)) ? { start, end } : null;
}

/**
 * The word under a right-click in editable text, or null. The mousedown has
 * already put the caret at the click point; nothing is selected yet because
 * the browser only selects a misspelled word after the 'contextmenu' event.
 */
export function wordAtPoint(target: HTMLElement, x: number, y: number): SpellTarget | null {
  const field = textField(target);
  if (field) {
    if (field.readOnly || field.disabled || field.type === 'password' || field.selectionStart === null) return null;
    const bounds = wordBounds(field.value, field.selectionStart);
    if (bounds && field.selectionStart !== field.selectionEnd
      && (field.selectionStart !== bounds.start || field.selectionEnd !== bounds.end)) return null;
    return bounds ? { kind: 'field', el: field, ...bounds, word: field.value.slice(bounds.start, bounds.end) } : null;
  }
  const root = target.closest<HTMLElement>('[contenteditable="true"]');
  const caret = root ? caretRangeAtPoint(x, y) : null;
  if (!root || !caret || caret.startContainer.nodeType !== Node.TEXT_NODE || !root.contains(caret.startContainer)) return null;
  const node = caret.startContainer as Text;
  const bounds = wordBounds(node.data, caret.startOffset);
  if (!bounds) return null;
  const range = document.createRange();
  range.setStart(node, bounds.start);
  range.setEnd(node, bounds.end);
  // The caret snaps to the nearest text, so make sure the pointer is really on the word.
  const onWord = [...range.getClientRects()].some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);
  return onWord ? { kind: 'rich', root, range, word: range.toString() } : null;
}

/** Replaces the misspelled word. False when the text changed while the menu was open. */
function replaceMisspelling(target: SpellTarget, replacement: string): boolean {
  if (target.kind === 'field') {
    const { el, start, end, word } = target;
    if (el.value.slice(start, end) !== word) return false;
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    // execCommand keeps the edit on the field's undo stack and fires React's onChange.
    if (!document.execCommand('insertText', false, replacement)) {
      el.setRangeText(replacement, start, end, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }
  const { root, range, word } = target;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote does not type its ProseMirror view
  const view = (getActiveBlockNoteEditor() as any)?._tiptapEditor?.view as import('prosemirror-view').EditorView | undefined;
  if (view && view.dom.contains(range.startContainer) && view.dom.contains(range.endContainer)) {
    const from = view.posAtDOM(range.startContainer, range.startOffset);
    const to = view.posAtDOM(range.endContainer, range.endOffset);
    if (view.state.doc.textBetween(from, to) !== word) return false;
    view.dispatch(view.state.tr.insertText(replacement, from, to));
    view.focus();
    return true;
  }
  if (!root.isConnected || range.toString() !== word) return false;
  root.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand('insertText', false, replacement);
  return true;
}

export function GlobalContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [spellMenu, setSpellMenu] = useState<SpellMenuState | null>(null);
  const [contactText, setContactText] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const endBrowserWordRef = useRef<() => void>(() => {});
  // Outlives the menu: the dialog opens as the menu closes.
  const [useCaseLaunch, setUseCaseLaunch] = useState<UseCaseLaunch | null>(null);
  // Browsers collapse the current selection if a right-click lands outside its
  // bounds, *before* the 'contextmenu' event fires — losing the text the user
  // meant to act on. Capture the selection on mousedown (capture phase, which
  // runs before that collapse) so we can fall back to it.
  const lastMouseDownSelection = useRef<string>('');
  // Right-clicks whose *mousedown* is left to the browser (so the caret lands on
  // the clicked word): in editable text with nothing selected, or with Shift held.
  // This is not the menu: the 'contextmenu' handler still blocks the browser's
  // own menu for every right-click except Shift+right-click.
  const nativeMenuForThisClick = useRef(false);
  // A native right-click in editable text makes the browser select the word
  // under the cursor. That selection is not the user's, so it must not show the
  // formatting toolbar or turn the next right-click into Athena's menu. The
  // exact range is remembered: it stays "the browser's" (even after Escape
  // closes the spelling menu) until the selection actually changes.
  const browserWordSelection = useRef<{ startedAt: number; range: SelectionRange | null } | null>(null);

  const openMenu = useCallback((e: MouseEvent | React.MouseEvent, item: CtxItemData) => {
    e.preventDefault();
    setMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY, item });
  }, []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      // A right-click: the right button, or Ctrl+click on a Mac.
      if (e.button === 2 || (e.button === 0 && e.ctrlKey && IS_MAC)) {
        const sel = window.getSelection()?.toString().trim() ?? '';
        const inEditable = (e.target as HTMLElement | null)?.closest('[contenteditable="true"], input, textarea') != null;
        // What is visibly selected right now (the editor's own state can lag a
        // click behind, and it remembers old selections).
        const browserWord = isBrowserWordSelection();
        const inNote = (e.target as HTMLElement | null)?.closest('.bn-editor') != null;
        const hasSelection = !browserWord && (sel.length > 2 || (inNote && sel.length > 0) || hasBlockNoteCellSelection());
        nativeMenuForThisClick.current = e.shiftKey || (inEditable && !hasSelection);
        // Let the browser place the caret on the word under the cursor, which is
        // what its context menu needs to offer spelling corrections.
        if (nativeMenuForThisClick.current) {
          lastMouseDownSelection.current = '';
          if (inEditable) {
            browserWordSelection.current = { startedAt: performance.now(), range: browserWord ? currentSelectionRange() : null };
            document.body.classList.add('kh-native-context');
            clearActiveBlockNoteSelectionSnapshot();
            suspendBlockNoteSelectionCapture();
          }
          return;
        }
        if (browserWord) {
          // Right-click elsewhere after a spelling menu: drop the browser's word
          // so it is not treated as the text to act on.
          endBrowserWordSelection();
          window.getSelection()?.removeAllRanges();
          lastMouseDownSelection.current = '';
        } else {
          endBrowserWordSelection();
          lastMouseDownSelection.current = sel;
        }
        // Freeze the BlockNote selection snapshot right now, before the
        // browser's native "select word under cursor to build its context
        // menu" behavior can run. That native behavior happens between
        // mousedown and the contextmenu event and isn't something JS can
        // prevent — but if we stop *our own* snapshot from listening to any
        // selectionchange it triggers, the real (multi-row) selection the
        // user made a moment earlier survives intact.
        suspendBlockNoteSelectionCapture();
        // Stop the event dead here (capture phase, before it reaches the
        // target). This prevents BOTH the browser's default "collapse
        // selection to click point" behavior AND any rich-text editor
        // (ProseMirror/BlockNote) from seeing the mousedown and repositioning
        // or collapsing its own internal selection (e.g. a table
        // CellSelection) in response to the right-click.
        e.preventDefault();
        e.stopPropagation();
      } else {
        // A fresh left-click/drag is starting a new selection — resume
        // tracking so the next right-click has an up-to-date snapshot.
        endBrowserWordSelection();
        resumeBlockNoteSelectionCapture();
      }
    }
    function isBrowserWordSelection(): boolean {
      const range = browserWordSelection.current?.range;
      return range != null && sameSelectionRange(range, currentSelectionRange());
    }
    function endBrowserWordSelection() {
      if (!browserWordSelection.current) return;
      browserWordSelection.current = null;
      document.body.classList.remove('kh-native-context');
      resumeBlockNoteSelectionCapture();
    }
    function onSelectionChange() {
      const pending = browserWordSelection.current;
      if (!pending) return;
      const current = currentSelectionRange();
      if (performance.now() - pending.startedAt < BROWSER_WORD_WINDOW_MS) {
        // The browser selects the word while opening its menu.
        if (current) pending.range = current;
      } else if (!pending.range || !sameSelectionRange(pending.range, current)) {
        // The user changed the selection (typed, picked a suggestion, extended it…).
        endBrowserWordSelection();
      }
    }
    function onKeyDown() {
      // Keyboard activity before the browser selected a word means any later selection is the user's.
      if (browserWordSelection.current && !browserWordSelection.current.range) endBrowserWordSelection();
    }
    function onFocusIn(e: FocusEvent) {
      // Fetch the dictionary before the first right-click needs it.
      if ((e.target as HTMLElement | null)?.closest?.('[contenteditable="true"], input, textarea')) {
        document.removeEventListener('focusin', onFocusIn, true);
        loadSpelling().catch((err: unknown) => { console.warn('[GlobalContextMenu] spelling dictionary unavailable:', err); });
      }
    }
    endBrowserWordRef.current = endBrowserWordSelection;
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.body.classList.remove('kh-native-context');
    };
  }, []);

  useEffect(() => {
    let spellingRequest = 0;
    const cancelPendingSpelling = (): void => { spellingRequest++; };
    function onContextMenu(e: MouseEvent) {
      const request = ++spellingRequest;
      setSpellMenu(null);
      setMenu(null);
      const target = e.target as HTMLElement;
      if (e.shiftKey) {
        // Shift+right-click always gets the browser's own menu.
        nativeMenuForThisClick.current = false;
        return;
      }
      const selected = window.getSelection()?.toString().trim() ?? '';
      const clickedWord = wordAtPoint(target, e.clientX, e.clientY);
      const field = textField(target);
      const selectedFieldWord = clickedWord?.kind === 'field' && field?.selectionStart !== field?.selectionEnd;
      if (nativeMenuForThisClick.current || (clickedWord && (selected === clickedWord.word || selectedFieldWord))) {
        // Right-click in editable text with nothing selected. Handling it here
        // (preventDefault) also stops the browser selecting the whole word.
        nativeMenuForThisClick.current = false;
        endBrowserWordRef.current();
        const word = clickedWord;
        const misspelled = word ? isMisspelled(word.word) : false;
        if (word && misspelled) {
          e.preventDefault();
          openEditMenu(e, target, word);
          return;
        }
        if (word && misspelled === null) {
          // First right-click before the dictionary has arrived: wait for it.
          e.preventDefault();
          const edit = editTargetAt(target, e.clientX, e.clientY);
          loadSpelling().then(
            () => {
              if (request !== spellingRequest || !target.isConnected) return;
              if (isMisspelled(word.word)) openEditMenu(e, target, word, edit);
              else if (!openAthenaMenu(e, target)) openEditMenu(e, target, null, edit);
            },
            () => {
              if (request === spellingRequest && target.isConnected) openEditMenu(e, target, word, edit);
            },
          );
          return;
        }
      }
      if (openAthenaMenu(e, target)) return;
      // Nothing for Athena to offer: never fall back to the browser's own menu
      // (Shift+right-click is the way to reach it). Editable text gets a dark
      // Cut/Copy/Paste menu; anywhere else, no menu.
      e.preventDefault();
      openEditMenu(e, target, null);
    }

    function openEditMenu(e: MouseEvent, target: HTMLElement, spelling: SpellTarget | null, known?: EditTarget | null) {
      const edit = known !== undefined ? known : editTargetAt(target, e.clientX, e.clientY);
      if (!edit) return;
      setMenu(null);
      setSpellMenu({ x: e.clientX, y: e.clientY, edit, spelling });
    }

    /** Athena's normal menu. False when it has nothing to offer for this click. */
    function openAthenaMenu(e: MouseEvent, target: HTMLElement): boolean {
      const img = target.closest('img');
      if (img instanceof HTMLImageElement) {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY,
          item: { title: img.alt || 'Image', imageUrl: img.currentSrc || img.src, url: img.currentSrc || img.src, nodeType: 'note' } });
        return true;
      }
      const liveSel = window.getSelection()?.toString().trim() ?? '';
      const candidate = target.closest('.bn-editor') ? capturePassageSelection() : null;
      const passageSelection = candidate && target.closest('[data-ctx-ref-type="note"]')?.getAttribute('data-ctx-ref-id') === candidate.noteId
        ? candidate : null;
      // BlockNote/ProseMirror table cell-range selections don't populate the
      // native browser Selection object correctly — ask the editor directly
      // first (covers both plain text and table selections in notes).
      const editorSel = getActiveBlockNoteSelectedText();
      const inChatArea = target.closest('.ai-messages') !== null;
      const sel = passageSelection?.text ?? (inChatArea && liveSel.length > 2 ? liveSel
        : editorSel.length > 2 ? editorSel
        : liveSel.length > 2 ? liveSel
        : lastMouseDownSelection.current);
      const hasSelection = passageSelection !== null || sel.length > 2;

      // 1. Walk DOM for data-ctx-title
      let el: HTMLElement | null = target;
      let ctxTitle: string | null = null;
      while (el && !ctxTitle) {
        ctxTitle = el.getAttribute('data-ctx-title');
        if (!ctxTitle) el = el.parentElement;
      }
      if (ctxTitle && el) {
        e.preventDefault();
        // If user has selected text inside this element, that selection is the body.
        // The element's title/url/ref become the source context.
        const body = hasSelection ? sel : (el.getAttribute('data-ctx-body') ?? undefined);
        const rawTags = el.getAttribute('data-ctx-tags');
        const tags = rawTags ? rawTags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
        const rawTagIds = el.getAttribute('data-ctx-tag-ids');
        const taxonomyTagIds = rawTagIds ? rawTagIds.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
        setMenu({
          x: e.clientX, y: e.clientY,
          item: {
            title:   ctxTitle,
            ...(body                                  ? { body                                         } : {}),
            ...(hasSelection                          ? { fromSelection: true                          } : {}),
            ...(passageSelection ? { passageSelection } : {}),
            ...(el.getAttribute('data-ctx-source')   ? { source:  el.getAttribute('data-ctx-source')! } : {}),
            ...(el.getAttribute('data-ctx-url')      ? { url:     el.getAttribute('data-ctx-url')!    } : {}),
            ...(el.getAttribute('data-ctx-ref-id')   ? { refId:   el.getAttribute('data-ctx-ref-id')! } : {}),
            ...(el.getAttribute('data-ctx-ref-type') ? { refType: el.getAttribute('data-ctx-ref-type')!} : {}),
            ...(tags?.length                         ? { tags                                          } : {}),
            ...(taxonomyTagIds?.length                ? { taxonomyTagIds                                } : {}),
            nodeType: el.getAttribute('data-ctx-type') ?? 'text',
          },
        });
        return true;
      }

      // 3. Text selection (no ctx element found)
      if (sel.length > 2) {
        e.preventDefault();
        const inChat = target.closest('.ai-messages') !== null;
        setMenu({ x: e.clientX, y: e.clientY,
          item: {
            title: inChat ? 'Athena chat' : sel.length > 80 ? sel.slice(0, 80) + '…' : sel,
            body: sel,
            fromSelection: true,
            ...(inChat ? { fromChat: true, source: 'Athena chat' } : {}),
            nodeType: 'note',
          } });
        return true;
      }

      // 4. Anchor link
      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      if (anchor?.href) {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY,
          item: { title: anchor.textContent?.trim() || anchor.href, url: anchor.href, nodeType: 'text' } });
        return true;
      }
      // 5. Right-click on an Athena reply with nothing selected: act on the whole reply
      const reply = target.closest('.ai-bubble-text, .ai-bubble-text--md') as HTMLElement | null;
      if (reply) {
        const text = reply.innerText.trim();
        if (text.length > 2 && reply.closest('.ai-bubble--user') === null) {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY,
            item: { title: 'Athena chat', body: text, fromSelection: true, fromChat: true, source: 'Athena chat', nodeType: 'note' } });
          return true;
        }
      }
      return false;
    }

    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('mousedown', cancelPendingSpelling, true);
    document.addEventListener('keydown', cancelPendingSpelling, true);
    return () => {
      spellingRequest++;
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('mousedown', cancelPendingSpelling, true);
      document.removeEventListener('keydown', cancelPendingSpelling, true);
    };
  }, []);

  return (
    <Ctx.Provider value={{ openMenu }}>
      {children}
      {menu && createPortal(
        <GlobalCtxMenu x={menu.x} y={menu.y} item={menu.item} onClose={() => setMenu(null)}
          onViewImage={image => { setMenu(null); setImagePreview(image); }}
          onContact={text => { setMenu(null); setContactText(text); }}
          onUseCase={(launch) => { setMenu(null); setUseCaseLaunch(launch); }} />,
        document.body,
      )}
      {spellMenu && createPortal(
        <SpellingMenu key={`${spellMenu.x},${spellMenu.y}`} {...spellMenu} onClose={() => setSpellMenu(null)} />,
        document.body,
      )}
      {useCaseLaunch && <UseCaseLauncher launch={useCaseLaunch} onClose={() => { setUseCaseLaunch(null); }} />}
      {imagePreview && <ImageViewer image={imagePreview} onClose={() => { setImagePreview(null); }} />}
      {contactText !== null && <Modal open passiveModal size="sm" modalHeading="Identify contacts from text"
        onRequestClose={() => setContactText(null)}><ContactCapture text={contactText} /></Modal>}
    </Ctx.Provider>
  );
}

const SHORTCUT = IS_MAC ? '⌘' : 'Ctrl+';

/** Puts focus and the selection back where they were when the menu opened. */
function restoreEditTarget(edit: EditTarget): void {
  if (edit.kind === 'field') {
    edit.el.focus({ preventScroll: true });
    edit.el.setSelectionRange(edit.start, edit.end);
    return;
  }
  edit.root.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(edit.range);
}

function insertIntoEditTarget(edit: EditTarget, text: string): void {
  restoreEditTarget(edit);
  if (document.execCommand('insertText', false, text)) return;
  if (edit.kind === 'field') {
    edit.el.setRangeText(text, edit.start, edit.end, 'end');
    edit.el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/**
 * Athena's dark replacement for the browser's right-click menu in editable text
 * with nothing selected (a selection gets Athena's main menu, which can copy it).
 */
function SpellingMenu({ x, y, edit, spelling, onClose }: SpellMenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writable = edit.kind === 'rich' || (!edit.el.readOnly && !edit.el.disabled);

  useEffect(() => {
    if (!spelling) return;
    let live = true;
    spellingSuggestions(spelling.word)
      .then((list) => { if (live) setSuggestions(list); })
      .catch((err: unknown) => {
        console.warn('[SpellingMenu] suggestions failed:', err);
        if (live) setError('Spelling suggestions are unavailable right now.');
      });
    return () => { live = false; };
  }, [spelling]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) el.style.left = `${Math.max(0, x - r.width)}px`;
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(0, y - r.height)}px`;
  });

  useEffect(() => {
    if (spelling && suggestions === null) return;
    ref.current?.querySelector<HTMLButtonElement>('.gctx__item:not(:disabled)')?.focus({ preventScroll: true });
  }, [spelling, suggestions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        restoreEditTarget(edit);
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.gctx__item:not(:disabled)') ?? []);
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
      items[next]?.focus();
    };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, edit]);

  const pick = (replacement: string) => {
    if (spelling && replaceMisspelling(spelling, replacement)) onClose();
    else setError('The text changed. Right-click the word again.');
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      insertIntoEditTarget(edit, text);
      onClose();
    } catch {
      setError(`Your browser blocked the clipboard. Use ${SHORTCUT}V instead.`);
    }
  };

  const selectAll = () => {
    if (edit.kind === 'field') { edit.el.focus({ preventScroll: true }); edit.el.select(); }
    else { edit.root.focus({ preventScroll: true }); document.execCommand('selectAll'); }
    onClose();
  };

  return (
    <div ref={ref} className="gctx gctx--spelling" role="menu"
      aria-label={spelling ? `Spelling suggestions for ${spelling.word}` : 'Edit'}
      onContextMenu={(e) => { e.preventDefault(); }}>
      {spelling && <>
        <div className="gctx__preview">
          <span className="gctx__source">Spelling</span>
          <span className="gctx__title gctx__title--misspelt">{spelling.word}</span>
        </div>
        <div className="gctx__divider" />
        {suggestions === null && error === null ? <p className="gctx__note">Finding suggestions…</p>
          : suggestions?.length === 0 ? <p className="gctx__note">No suggestions</p>
          : suggestions?.map((s) => (
            <button key={s} type="button" role="menuitem" className="gctx__item gctx__item--suggestion" onClick={() => { pick(s); }}>
              {s}
            </button>
          ))}
        <div className="gctx__divider" />
      </>}
      {error !== null && <p className="gctx__note gctx__note--error" role="alert">{error}</p>}
      <button type="button" role="menuitem" className="gctx__item" disabled={!writable} onClick={() => { void paste(); }}>
        Paste<span className="gctx__shortcut">{SHORTCUT}V</span>
      </button>
      <button type="button" role="menuitem" className="gctx__item" onClick={selectAll}>
        Select all<span className="gctx__shortcut">{SHORTCUT}A</span>
      </button>
    </div>
  );
}

type PanelState = 'menu' | 'picker' | 'tags';

function GlobalCtxMenu({ x, y, item, onClose, onUseCase, onContact, onViewImage }: { x: number; y: number; item: CtxItemData; onClose: () => void; onUseCase: (launch: UseCaseLaunch) => void; onContact: (text: string) => void; onViewImage: (image: ImagePreview) => void }) {
  const [panel, setPanel]   = useState<PanelState>('menu');
  const [selectedId, setId] = useState<string | null>(null);
  const [sent, setSent]     = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const qc  = useQueryClient();
  const navigate = useNavigate();
  const { openAthena } = useAthenaContext();
  const [results, setResults] = useState<{ action: NoteExtractionAction; label: string; to?: string }[]>([]);

  const noteId = item.fromSelection === true && item.refType === 'note' ? item.refId : undefined;
  const useCaseLaunch = item.fromSelection === true ? null : launchFromRef(item.refType, item.refId, item.title);
  const quote = (item.body ?? '').trim();
  const sourceNote = item.refType === 'note' ? item.title : null;

  // Records what was done with the selection so the note can mark it.
  const record = (action: NoteExtractionAction, label: string, to?: string, target?: { type: string; id: string }) => {
    setResults((r) => [...r, { action, label, ...(to ? { to } : {}) }]);
    if (!noteId || quote === '') return;
    void api.addNoteExtraction(noteId, {
      quote: quote.slice(0, 4000), action, targetLabel: label,
      ...(target ? { targetType: target.type, targetId: target.id } : {}),
    }).then(() => qc.invalidateQueries({ queryKey: ['note-extractions', noteId] }))
      .catch((err: unknown) => { console.warn('[GlobalContextMenu] could not record extraction marker:', err); });
  };

  const { mutate: extractNote, isPending: extractingNote } = useMutation({
    mutationFn: async () => {
      setActionError(null);
      const { markdownToNoteBlocks } = await import('../notes/markdownToBlocks');
      const title = quote.split('\n')[0]!.slice(0, 60).trim() || 'Extracted note';
      const doc = await createNote({ title, contentType: 'note', contentJson: JSON.stringify(markdownToNoteBlocks(quote)) });
      if (!doc) throw new Error('Could not create note.');
      return { id: doc.id, title };
    },
    onSuccess: ({ id, title }) => {
      void qc.invalidateQueries({ queryKey: ['notes'] });
      record('note', title, `/think?noteId=${id}`, { type: 'note', id });
    },
    onError: (err) => { setActionError(err instanceof Error ? err.message : 'Could not create note.'); },
  });

  const discuss = () => {
    openAthena(`Let's discuss this passage:\n\n"${quote.slice(0, 1500)}"\n\nWhat are the key points, and what should I do with it?`,
      { type: 'note', title: item.title, ...(item.refId ? { id: item.refId } : {}) });
    record('athena', 'Discussed with Athena');
    onClose();
  };

  // Reposition if near screen edge — runs after every render so dimensions are known
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right  > window.innerWidth)  el.style.left = `${x - r.width}px`;
    if (r.bottom > window.innerHeight) el.style.top  = `${y - r.height}px`;
  });

  useEffect(() => {
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown',   onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  const { data, isLoading, isError: canvasError, refetch: retryCanvases } = useQuery({
    queryKey: ['canvases-list'],
    queryFn: async () => {
      const result = await api.listCanvases();
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    staleTime: 30_000,
    enabled: panel === 'picker',
  });
  const canvases: CanvasSummaryApi[] = data?.filter((c) => c.canvasType !== 'diagram') ?? [];

  const { mutate: createSpark, isPending: creatingSpark, data: savedSpark } = useMutation({
    mutationFn: async () => {
      setActionError(null);
      const result = await api.createSpark({
        body: (item.body ?? item.title).trim(),
        tags: (item.tags ?? []).map((tag) => tag.split('|')[0] ?? tag),
        source_id: item.refId && item.refType ? item.refId : null,
        source_type: item.refId && item.refType ? item.refType : null,
      });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (spark) => {
      clearActiveBlockNoteSelectionSnapshot();
      record('spark', 'Spark', '/think?view=sparks', { type: 'spark', id: spark.id });
      void qc.invalidateQueries({ queryKey: ['sparks'] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error) => { setActionError(error instanceof Error ? error.message : 'Could not save Spark. Please retry.'); },
  });
  const canvasItem: CtxItemData = savedSpark ? {
    title: savedSpark.body.length > 80 ? savedSpark.body.slice(0, 80) + '…' : savedSpark.body,
    body: savedSpark.body, refId: savedSpark.id, refType: 'spark', source: 'Spark',
  } : item;

  const { mutate: addNode, isPending } = useMutation({
    mutationFn: async (canvasId: string) => {
      setActionError(null);
      const result = await api.addToCanvas(canvasId, {
        label: canvasItem.title,
        ...(canvasItem.body    ? { body:    canvasItem.body    } : {}),
        ...(canvasItem.url     ? { url:     canvasItem.url     } : {}),
        ...(canvasItem.refId   ? { refId:   canvasItem.refId   } : {}),
        ...(canvasItem.refType ? { refType: canvasItem.refType } : {}),
      });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (_res, canvasId) => {
      setSent(true);
      const name = canvases.find((c) => c.id === canvasId)?.title ?? 'Canvas';
      record('canvas', name, `/think?mapId=${canvasId}`, { type: 'canvas', id: canvasId });
      void qc.invalidateQueries({ queryKey: ['canvases-list'] });
      void qc.invalidateQueries({ queryKey: ['canvas', canvasId] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
      setPanel('menu');
    },
    onError: (err) => {
      console.error('[GlobalContextMenu] add to map failed:', err);
      setActionError(err instanceof Error ? err.message : 'Could not add to Canvas. Please retry.');
    },
  });

  const copyUrl  = async () => { if (item.url) await navigator.clipboard.writeText(item.url); onClose(); };
  const copyText = async () => { await navigator.clipboard.writeText(item.body ?? item.title); onClose(); };

  const { mutate: createTasks, isPending: creatingTasks, data: createdTaskIds } = useMutation({
    mutationFn: async () => {
      const sourceText = item.body ?? item.title;
      const tags = (item.tags ?? []).map((t) => t.split('|')[0] ?? t);
      const taxonomyTagIds = item.taxonomyTagIds ?? [];
      const parsed = await extractTasksWithAI(sourceText);
      const dueDate = toISODateString(addWorkingDays(new Date(), 2));
      const sourceNoteId = item.refType === 'note' ? item.refId : undefined;
      const created = await Promise.all(parsed.map(async (draft) => {
        const res = await api.createTask({
          title: draft.title,
          body: draft.body,
          status: 'backlog',
          dueDate,
          ...(tags.length > 0 ? { tags } : {}),
          ...(taxonomyTagIds.length > 0 ? { taxonomyTagIds } : {}),
        });
        const id = res.success ? res.data.id : undefined;
        // Link back to the note so the task card can open where it came from.
        if (id && sourceNoteId) {
          await api.addTaskLink(id, {
            targetType: 'note', targetId: sourceNoteId, targetTitle: item.title,
            targetUrl: `/think?noteId=${encodeURIComponent(sourceNoteId)}`,
          }).catch((err: unknown) => { console.warn('[GlobalContextMenu] could not link task to note:', err); });
        }
        return id;
      }));
      return created.filter((id): id is string => typeof id === 'string');
    },
    onSuccess: (ids) => {
      clearActiveBlockNoteSelectionSnapshot();
      const first = ids[0];
      record('task', ids.length > 1 ? `${ids.length} tasks` : 'Task',
        ids.length === 1 && first ? `/plan?taskId=${first}` : '/plan',
        first ? { type: 'task', id: first } : undefined);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err) => {
      console.error('[GlobalContextMenu] createTask failed:', err);
    },
  });
  const taskCount = createdTaskIds?.length;

  const posStyle: React.CSSProperties = { left: x, top: y };

  const hasQuote = quote !== '';
  const showSource = (sourceNote !== null && sourceNote !== quote) || item.fromChat === true;
  if (panel === 'menu') return (
    <div ref={ref} className="gctx" style={posStyle}>
      <div className="gctx__preview">
        {hasQuote && item.fromSelection === true
          ? <blockquote className="gctx__quote">{quote}</blockquote>
          : <span className="gctx__title">{item.title}</span>}
        {showSource && item.fromSelection === true
          ? <span className="gctx__source">{item.fromChat === true ? 'From Athena chat' : `From note: ${sourceNote}`}</span>
          : item.source && item.fromSelection !== true && <span className="gctx__source">{item.source}</span>}
      </div>
      <div className="gctx__divider" />
      {item.passageSelection && <button type="button" className="gctx__item" onClick={() => { setPanel('tags'); }}>
        Tag selected passage…
      </button>}
      <button className="gctx__item" onClick={() => setPanel('picker')}>
        <Diagram size={15} /> {savedSpark ? 'Send Spark to Canvas…' : 'Add to linked canvas…'}
      </button>
      {item.refType !== 'spark' && (
        <button className="gctx__item" disabled={creatingSpark || savedSpark !== undefined} onClick={() => { createSpark(); }}>
          {savedSpark ? <><Checkmark size={15} /> Spark saved</>
            : <><Idea size={15} /> {creatingSpark ? 'Saving Spark…' : 'Create Spark'}</>}
        </button>
      )}
      {useCaseLaunch !== null && (
        <button type="button" className="gctx__item" onClick={() => { onUseCase(useCaseLaunch); }}>
          <Rocket size={15} /> Make a use case…
        </button>
      )}
      <button
        className="gctx__item"
        onClick={() => { createTasks(); }}
        disabled={creatingTasks || taskCount !== undefined}
      >
        {taskCount !== undefined
          ? <><Checkmark size={15} /> {taskCount > 1 ? `${taskCount} tasks created` : 'Task created'}</>
          : <><TaskAdd size={15} /> {creatingTasks ? 'Thinking…' : 'Create Task'}</>}
      </button>
      {item.fromSelection === true && (
        <>
          <button className="gctx__item" onClick={() => onContact(item.body ?? item.title)}>
            <DocumentAdd size={15} /> Identify contacts from text
          </button>
          <button className="gctx__item" disabled={extractingNote} onClick={() => { extractNote(); }}>
            <DocumentAdd size={15} /> {extractingNote ? 'Creating note…' : 'Extract to new note'}
          </button>
          {item.fromChat !== true && (
            <button className="gctx__item" onClick={discuss}>
              <ChatBot size={15} /> Discuss with Athena
            </button>
          )}
        </>
      )}
      {(item.url || hasQuote) && <div className="gctx__divider" />}
      {item.url && (
        <button className="gctx__item" onClick={() => { void copyUrl(); }}>
          <Link size={15} /> Copy URL
        </button>
      )}
      {item.imageUrl && <button className="gctx__item" onClick={() => {
        setActionError(null);
        void copyImage(item.imageUrl!, id => api.getImageFile(id)).then(onClose).catch((error: unknown) => {
          setActionError(error instanceof Error ? error.message : 'Could not copy image. Check clipboard permissions and try again.');
        });
      }}><Copy size={15} /> Copy image</button>}
      {item.imageUrl && <button className="gctx__item" onClick={() => { onViewImage({ source: item.imageUrl!, title: item.title }); }}>
        <ImageIcon size={15} /> Open image full screen
      </button>}
      <button className="gctx__item" onClick={() => { void copyText(); }}>
        <Copy size={15} /> Copy text
      </button>
      {results.length > 0 && (
        <div className="gctx__results">
          {results.map((r, i) => (
            <div key={i} className="gctx__result">
              <Checkmark size={14} />
              <span>{r.label}</span>
              {r.to && <button type="button" onClick={() => { navigate(r.to!); onClose(); }}>Open <ArrowRight size={12} /></button>}
            </div>
          ))}
        </div>
      )}
      {actionError && <p className="gctx__error" role="alert">{actionError}</p>}
    </div>
  );

  if (panel === 'tags') return <div ref={ref} className="gctx gctx--picker" style={posStyle} role="menu" aria-label="Tag selected passage">
    <div className="gctx__picker-header">
      <button type="button" className="gctx__picker-back" aria-label="Back" onClick={() => { setPanel('menu'); }}>←</button>
      <span>Tag selected passage</span>
    </div>
    {(Object.keys(PASSAGE_TAGS) as PassageTag[]).map(kind => <button key={kind} type="button" role="menuitem"
      className="gctx__item" onClick={() => {
        const selection = item.passageSelection;
        if (!selection) return;
        void applyPassageTag(kind, selection).then(onClose).catch((error: unknown) => {
          setActionError(error instanceof Error ? error.message : 'Could not tag the passage.');
        });
      }}><span aria-hidden="true">{PASSAGE_TAGS[kind].icon}</span> {PASSAGE_TAGS[kind].label}</button>)}
    {actionError && <p className="gctx__error" role="alert">{actionError}</p>}
  </div>;

  return (
    <div ref={ref} className="gctx gctx--picker" style={posStyle}>
      <div className="gctx__picker-header">
        <button className="gctx__picker-back" onClick={() => setPanel('menu')}>←</button>
        <span>Add to linked canvas</span>
      </div>
      <div className="gctx__picker-preview">
        {canvasItem.source && <div className="gctx__picker-source">{canvasItem.source}</div>}
        <div className="gctx__picker-ptitle">{canvasItem.title}</div>
        {canvasItem.body && <div className="gctx__picker-pbody">{canvasItem.body.length > 140 ? canvasItem.body.slice(0, 140) + '…' : canvasItem.body}</div>}
        {canvasItem.imageUrl && <img src={canvasItem.imageUrl} alt="" className="gctx__picker-img" />}
      </div>
      <div className="gctx__picker-list">
        {isLoading && <div className="gctx__picker-empty">Loading…</div>}
        {canvasError && <div className="gctx__error" role="alert">Could not load canvases. <button className="gctx__picker-back" type="button" onClick={() => { void retryCanvases(); }}>Retry</button></div>}
        {!isLoading && !canvasError && canvases.length === 0 && <div className="gctx__picker-empty">No brainstorm canvases yet. Create one from Think → Canvas.</div>}
        {canvases.map((c) => (
          <button
            key={c.id}
            className={`gctx__picker-canvas${selectedId === c.id ? ' gctx__picker-canvas--active' : ''}`}
            onClick={() => setId(c.id)}
          >
            <Diagram size={14} /><span>{c.title}</span>{selectedId === c.id && <Checkmark size={13} />}
          </button>
        ))}
      </div>
      <button
        className="gctx__picker-send"
        disabled={!selectedId || isPending || sent}
        onClick={() => { if (selectedId) addNode(selectedId); }}
      >
        {sent ? <><Checkmark size={14} /> Added!</> : isPending ? 'Adding…' : 'Add to Canvas'}
      </button>
      {actionError && <p className="gctx__error" role="alert">{actionError}</p>}
    </div>
  );
}
