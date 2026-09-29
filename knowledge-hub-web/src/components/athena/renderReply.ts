/**
 * components/athena/renderReply.ts — turns an Athena reply (markdown from the
 * model) into display HTML: status chips, compact task cards with actions,
 * label/value cards, and markdown — then a final sanitiser pass.
 *
 * Pure functions (no React), so the rendering can be tested and reused
 * independently of the chat component.
 */
import type React from 'react';
import { renderMarkdown } from '../../utils/markdown';
import { sanitizeHtml } from '../../utils/sanitizeHtml';

// Colour-coded status chip rules applied to assistant replies before markdown
// rendering — turns plain-text status words into small pill badges so dense
// task-list replies are scannable at a glance instead of a wall of text.
const STATUS_CHIP_RULES: Array<[RegExp, string]> = [
  [/\bhigh priority\b/gi, '<span class="kh-chip kh-chip--danger">🔴 High priority</span>'],
  [/\bmedium priority\b/gi, '<span class="kh-chip kh-chip--warning">🟠 Medium priority</span>'],
  [/\blow priority\b/gi, '<span class="kh-chip kh-chip--neutral">⚪ Low priority</span>'],
  [/\bin progress\b/gi, '<span class="kh-chip kh-chip--info">🔵 In progress</span>'],
  [/\bto-review\b/gi, '<span class="kh-chip kh-chip--info">👀 To review</span>'],
  [/\bbacklog\b/gi, '<span class="kh-chip kh-chip--neutral">📥 Backlog</span>'],
  [/\boverdue\b/gi, '<span class="kh-chip kh-chip--danger">⚠️ Overdue</span>'],
];

// Turns "Overdue tasks: N" (bolded or plain) into a prominent alert banner
// instead of a plain heading — the single most important line in a task
// summary reply deserves to stand out.
function enrichOverdueBanner(text: string): string {
  return text.replace(/\*{0,2}Overdue tasks:\s*(\d+)\*{0,2}/gi, (_match, n: string) => {
    const count = parseInt(n, 10);
    if (count === 0) return '<div class="kh-alert kh-alert--success">✅ No overdue tasks</div>';
    return `<div class="kh-alert kh-alert--danger">⚠️ <strong>${count}</strong> overdue task${count === 1 ? '' : 's'} need attention</div>`;
  });
}

// Applies the chip/banner enrichment to assistant text only, skipping the
// inside of fenced code blocks so real code snippets are left untouched.
function enrichAssistantText(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part; // fenced code block — leave as-is
      let out = enrichOverdueBanner(part);
      out = enrichSourceLinks(out);
      for (const [re, replacement] of STATUS_CHIP_RULES) {
        out = out.replace(re, replacement);
      }
      return out;
    })
    .join('');
}

// Turns a standalone "Link: <url>" line (e.g. after a create_note_draft
// reply) into a clickable button instead of a raw, awkward-to-read URL —
// only used for links that fall outside a task card block (see
// buildTaskCardHtml for the in-card version).
function enrichSourceLinks(text: string): string {
  return text.replace(/^Link:\s*(\S+)\s*$/gim, (_m, url: string) =>
    `<a class="kh-source-link" href="${escapeHtml(toInAppHref(url))}" target="_blank" rel="noreferrer">🔗 Open</a>`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Short, scannable date for card display, e.g. "24 Jul 2026" — distinct from
// formatDateForSpeech() above, which spells the month out for TTS.
function formatDueDateShort(due: string): string {
  const m = due.match(/^\d{4}-\d{2}-\d{2}$/);
  if (!m) return escapeHtml(due);
  const d = new Date(`${due}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return escapeHtml(due);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

function statusChipHtml(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('progress')) return '<span class="kh-chip kh-chip--info">🔵 In progress</span>';
  if (s.includes('review')) return '<span class="kh-chip kh-chip--info">👀 To review</span>';
  if (s.includes('backlog')) return '<span class="kh-chip kh-chip--neutral">📥 Backlog</span>';
  if (s.includes('blocked')) return '<span class="kh-chip kh-chip--danger">⛔ Blocked</span>';
  if (s.includes('done') || s.includes('complete')) return '<span class="kh-chip kh-chip--success">✅ Done</span>';
  return `<span class="kh-chip kh-chip--neutral">${escapeHtml(status)}</span>`;
}

function priorityChipHtml(priority: string): string {
  const p = priority.toLowerCase();
  if (p === 'urgent') return '<span class="kh-chip kh-chip--danger">🔺 Urgent</span>';
  if (p === 'high') return '<span class="kh-chip kh-chip--danger">🔴 High priority</span>';
  if (p === 'medium' || p === 'normal') return '<span class="kh-chip kh-chip--warning">🟠 Medium priority</span>';
  if (p === 'low') return '<span class="kh-chip kh-chip--neutral">⚪ Low priority</span>';
  return `<span class="kh-chip kh-chip--neutral">${escapeHtml(priority)}</span>`;
}

/** Lookups the card renderer needs from the component (project names). */
export interface RenderContext {
  projectNameById: Map<string, string>;
}

const APP_ROUTES = ['/plan', '/think', '/today', '/discover', '/library', '/projects', '/my-work', '/chat'];

// Links from the backend carry whatever FRONTEND_BASE_URL it was built with
// (historically the raw azurestaticapps host). In-app links are rewritten to
// same-origin paths so they always open on the domain the user is actually on.
function toInAppHref(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    if (APP_ROUTES.some((route) => u.pathname === route || u.pathname.startsWith(`${route}/`))) {
      return `${u.pathname}${u.search}${u.hash}`;
    }
    return u.toString();
  } catch {
    return url;
  }
}

function taskIdFromLink(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url, window.location.origin).searchParams.get('taskId');
  } catch {
    return null;
  }
}

/** Escapes, strips a leading list number, and renders **bold** / *italic*. */
function inlineTitleHtml(title: string): string {
  return escapeHtml(title.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, ''))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
}

/** Whole days between an ISO date (YYYY-MM-DD) and today; positive = in the past. */
function daysPast(due: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  const dueMs = Date.parse(`${due}T00:00:00Z`);
  if (Number.isNaN(dueMs)) return null;
  const now = new Date();
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((todayMs - dueMs) / 86_400_000);
}

function isDoneStatus(status: string | undefined): boolean {
  return status !== undefined && /done|complete/i.test(status);
}

// A single task summary block — "**Title**" followed by Status:/Priority:/
// Project:/Due: lines — rendered as a compact card: title, one row of chips,
// then actions, so several tasks fit on screen at once.
function buildTaskCardHtml(title: string, fields: Record<string, string>, overdueFlag: boolean, ctx: RenderContext): string {
  const days = fields.due !== undefined ? daysPast(fields.due) : null;
  const done = isDoneStatus(fields.status);
  const overdue = !done && (overdueFlag || (days !== null && days > 0));
  const priorityClass = fields.priority ? ` kh-task-card--${fields.priority.toLowerCase()}` : '';
  const overdueClass = overdue ? ' kh-task-card--overdue' : '';
  const projectName = fields.project !== undefined
    ? ctx.projectNameById.get(fields.project) ?? fields.project
    : undefined;
  const dueText = fields.due !== undefined
    ? `${formatDueDateShort(fields.due)}${overdue && days !== null && days > 0 ? ` · ${days.toString()} day${days === 1 ? '' : 's'} overdue` : ''}`
    : '';
  const meta = [
    fields.status ? statusChipHtml(fields.status) : '',
    fields.priority ? priorityChipHtml(fields.priority) : '',
    projectName !== undefined
      ? `<span class="kh-task-card__detail"><span class="kh-task-card__detail-icon" aria-hidden="true">📁</span>${escapeHtml(projectName)}</span>`
      : '',
    dueText !== ''
      ? `<span class="kh-task-card__detail${overdue ? ' kh-task-card__detail--overdue' : ''}"><span class="kh-task-card__detail-icon" aria-hidden="true">📅</span>${dueText}</span>`
      : '',
  ].filter(Boolean).join('');
  const taskId = taskIdFromLink(fields.link);
  const actions = [
    fields.link
      ? `<a class="kh-task-card__action kh-task-card__action--primary" href="${escapeHtml(toInAppHref(fields.link))}" target="_blank" rel="noreferrer">Open in Plan</a>`
      : '',
    taskId !== null && !done
      ? `<button type="button" class="kh-task-card__action" data-task-action="done" data-task-id="${escapeHtml(taskId)}">Mark done</button>`
      : '',
    taskId !== null && !done
      ? `<button type="button" class="kh-task-card__action" data-task-action="snooze" data-task-id="${escapeHtml(taskId)}">Snooze a week</button>`
      : '',
  ].filter(Boolean).join('');
  return [
    `<div class="kh-task-card${priorityClass}${overdueClass}">`,
    `<div class="kh-task-card__title">${inlineTitleHtml(title)}</div>`,
    meta ? `<div class="kh-task-card__meta">${meta}</div>` : '',
    actions ? `<div class="kh-task-card__actions">${actions}</div>` : '',
    '</div>',
  ].filter(Boolean).join('');
}

function buildStructuredCardHtml(title: string, rows: Array<{ label: string; value: string }>): string {
  return [
    '<div class="kh-structured-card">',
    title !== '' ? `<div class="kh-structured-card__title">${inlineTitleHtml(title)}</div>` : '',
    '<div class="kh-structured-card__rows">',
    ...rows.map((row) => (
      row.value === ''
        ? `<div class="kh-structured-card__section">${escapeHtml(row.label)}</div>`
        : [
            '<div class="kh-structured-card__row">',
            `<dt>${escapeHtml(row.label)}</dt>`,
            `<dd>${renderMarkdown(row.value)}</dd>`,
            '</div>',
          ].join('')
    )),
    '</div>',
    '</div>',
  ].filter(Boolean).join('');
}

const TASK_TITLE_RE = /^(?:\d+[.)]\s*|[-*•]\s+)?\*\*(.+?)\*\*:?\s*$/;
const TASK_FIELD_RE = /^(?:[-*•]\s+)?\*{0,2}(Status|Priority|Project|Due|Link)\*{0,2}\s*:\s*\*{0,2}\s*(.+?)\s*$/i;
const TASK_OVERDUE_RE = /^(?:⚠️\s*)?overdue\s*$/i;
const STRUCTURED_FIELD_RE = /^([A-Z][A-Za-z0-9 /&().'-]{1,48})\s*:\s*(.*)$/;

// Scans assistant text line-by-line for task-summary blocks and swaps them
// for real cards, running everything else through the normal markdown +
// chip pipeline unchanged.
export function renderAssistantMessage(raw: string, ctx: RenderContext): string {
  const lines = raw.split('\n');
  const htmlParts: string[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length > 0) {
      htmlParts.push(renderMarkdown(enrichAssistantText(textBuf.join('\n'))));
      textBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    let idx = i;
    let overdue = false;
    if (TASK_OVERDUE_RE.test((lines[idx] ?? '').trim())) {
      overdue = true;
      idx += 1;
    }
    const titleMatch = TASK_TITLE_RE.exec((lines[idx] ?? '').trim());
    if (titleMatch) {
      const fields: Record<string, string> = {};
      let j = idx + 1;
      while (j < lines.length) {
        const l = (lines[j] ?? '').trim();
        const fieldMatch = TASK_FIELD_RE.exec(l);
        if (fieldMatch) {
          // Models often bold the whole line ("**Priority: high**"), leaving a stray closing **.
          fields[fieldMatch[1]!.toLowerCase()] = fieldMatch[2]!.replace(/\*+\s*$/, '').replace(/^\*+/, '').trim();
          j += 1;
          continue;
        }
        if (TASK_OVERDUE_RE.test(l)) {
          overdue = true;
          j += 1;
          continue;
        }
        break;
      }
      if (Object.keys(fields).length >= 2) {
        flushText();
        htmlParts.push(buildTaskCardHtml(titleMatch[1] ?? '', fields, overdue, ctx));
        i = j;
        continue;
      }
    }
    const currentLine = (lines[i] ?? '').trim();
    const nextLine = (lines[i + 1] ?? '').trim();
    const currentIsField = STRUCTURED_FIELD_RE.test(currentLine);
    const nextIsField = STRUCTURED_FIELD_RE.test(nextLine);
    if (currentLine !== '' && (currentIsField || nextIsField)) {
      const title = currentIsField ? '' : currentLine;
      let j = currentIsField ? i : i + 1;
      const rows: Array<{ label: string; value: string }> = [];
      while (j < lines.length) {
        const fieldLine = (lines[j] ?? '').trim();
        if (fieldLine === '') {
          j += 1;
          if (rows.length > 0) break;
          continue;
        }
        const fieldMatch = STRUCTURED_FIELD_RE.exec(fieldLine);
        if (!fieldMatch) break;
        rows.push({ label: fieldMatch[1]!.trim(), value: fieldMatch[2]!.trim() });
        j += 1;
      }
      if (rows.length >= 2) {
        flushText();
        htmlParts.push(buildStructuredCardHtml(title, rows));
        i = j;
        continue;
      }
    }
    textBuf.push(lines[i] ?? '');
    i += 1;
  }
  flushText();

  // Final allowlist pass — card/chip HTML is ours, but reply text is model output.
  return sanitizeHtml(htmlParts.join('\n'));
}

// Delegated click handler for the "Copy" button injected into fenced code
// blocks by renderMarkdown() — avoids attaching a listener per code block
// inside dangerouslySetInnerHTML content.
export function handleCodeCopyClick(e: React.MouseEvent<HTMLElement>): void {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
  if (!btn) return;
  const code = btn.parentElement?.querySelector('pre code');
  if (!code?.textContent) return;
  void navigator.clipboard.writeText(code.textContent).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('kh-code-copy-btn--copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('kh-code-copy-btn--copied');
    }, 1500);
  });
}
