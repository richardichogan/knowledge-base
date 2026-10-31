/** Discover → Inbox: indexed important email, labelled with the mailbox each one came from. */
import React, { useMemo, useState } from 'react';
import { Edit, Launch } from '@carbon/icons-react';
import type { ContentItemSummary } from '../../types';
import { ReviewWorkspace, ReviewItem } from '../ReviewWorkspace';

export interface InboxEmail {
  id: string;
  title: string;
  subject: string;
  sender: string;
  senderAddress: string | null;
  mailbox: string;
  mailboxAddress: string | null;
  receivedAt: string;
  url: string | null;
  isUnread: boolean;
}

const MAILBOX_NAMES: Record<string, string> = {
  blog: 'Blog',
  podcast: 'Podcast',
  alliance: 'IBM Alliance',
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function toInboxEmail(item: ContentItemSummary): InboxEmail {
  const meta = item.metadata ?? {};
  const label = text(meta['accountLabel']) ?? 'unknown';
  const from = text(meta['from']) ?? 'Unknown sender';
  const named = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const sender = named?.[1] ? named[1] : named?.[2] ?? from;
  return {
    id: item.id,
    title: item.title,
    subject: item.title.replace(/^\[[^\]]+\]\s*/, '') || '(no subject)',
    sender,
    senderAddress: named?.[2] ?? (from.includes('@') ? from : null),
    mailbox: label,
    mailboxAddress: text(meta['account']),
    receivedAt: item.publishedAt,
    url: item.url ?? null,
    isUnread: meta['isRead'] === false,
  };
}

export function mailboxName(label: string): string {
  return MAILBOX_NAMES[label] ?? label.charAt(0).toUpperCase() + label.slice(1);
}

function formatReceived(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

interface Props {
  items: ContentItemSummary[];
  onSocials: (item: { id: string; title: string }) => void;
  athenaEnabled?: boolean;
}

export const EmailInbox: React.FC<Props> = ({ items, onSocials, athenaEnabled = true }) => {
  const emails = useMemo(() => items.map(toInboxEmail), [items]);
  const mailboxes = useMemo(() => {
    const counts = new Map<string, { count: number; address: string | null }>();
    for (const e of emails) {
      const entry = counts.get(e.mailbox) ?? { count: 0, address: e.mailboxAddress };
      entry.count += 1;
      counts.set(e.mailbox, entry);
    }
    return [...counts.entries()].map(([label, v]) => ({ label, ...v }));
  }, [emails]);
  const [filter, setFilter] = useState<string | null>(null);
  const shown = filter === null ? emails : emails.filter((e) => e.mailbox === filter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = shown.find(email => email.id === selectedId) ?? shown[0];
  const selectedItem = items.find(item => item.id === selected?.id);

  return (
    <ReviewWorkspace storageKey="discover" label="Inbox" athenaEnabled={athenaEnabled}
      context={selected && selectedItem ? { type: 'email', title: selected.subject, id: selected.id,
        detail: `Selected indexed email summary and metadata (retrieve full saved email before claiming to have read its body):\n${JSON.stringify(selectedItem)}` }
        : { type: 'discover', title: 'Inbox', detail: 'No indexed email selected.' }}
      list={<div className="dc-inbox">
      {mailboxes.length > 1 && (
        <div className="dc-inbox-filters" role="group" aria-label="Filter by mailbox">
          <button type="button" className="dc-inbox-filter" aria-pressed={filter === null} onClick={() => { setFilter(null); }}>
            All mailboxes <span className="dc-inbox-filter__count">{emails.length}</span>
          </button>
          {mailboxes.map((m) => (
            <button key={m.label} type="button" className="dc-inbox-filter" data-mailbox={m.label}
              aria-pressed={filter === m.label} title={m.address ?? undefined}
              onClick={() => { setFilter(m.label); }}>
              <span className="dc-inbox-dot" aria-hidden="true" />
              {mailboxName(m.label)} <span className="dc-inbox-filter__count">{m.count}</span>
            </button>
          ))}
        </div>
      )}
      {shown.map(email => <ReviewItem key={email.id} title={email.subject} selected={selected?.id === email.id}
        meta={`${mailboxName(email.mailbox)} · ${email.sender} · ${formatReceived(email.receivedAt)}${email.isUnread ? ' · Unread' : ''}`}
        description={items.find(item => item.id === email.id)?.summary}
        onSelect={() => { setSelectedId(email.id); }} />)}
      {!shown.length && <p className="dc-empty">No indexed emails in this mailbox.</p>}
    </div>}
      detail={selected ? (() => { const e = selected; return (
          <article className={`dc-email dc-email--detail${e.isUnread ? ' dc-email--unread' : ''}`} data-mailbox={e.mailbox}>
            <div className="dc-email__mailbox" title={e.mailboxAddress ?? undefined}>
              <span className="dc-inbox-dot" aria-hidden="true" />
              <span className="dc-email__mailbox-name">{mailboxName(e.mailbox)}</span>
              {e.mailboxAddress !== null && <span className="dc-email__mailbox-address">{e.mailboxAddress}</span>}
            </div>
            <div className="dc-email__head">
              <span className="dc-email__sender" title={e.senderAddress ?? undefined}>{e.sender}</span>
              <time className="dc-email__date" dateTime={e.receivedAt}>{formatReceived(e.receivedAt)}</time>
            </div>
            <h2 className="dc-email__subject">{e.subject}</h2>
            <section className="dc-explore__section"><h3>Indexed summary</h3>
              <p>{selectedItem?.summary || 'No summary is available for this email. Open the original in Outlook.'}</p></section>
            <div className="dc-email__actions">
              {e.url !== null && (
                <a className="dc-action" href={e.url} target="_blank" rel="noreferrer">
                  <Launch size={14} /> Open in Outlook
                </a>
              )}
              <button type="button" className="dc-action dc-action--linkedin" onClick={() => { onSocials({ id: e.id, title: e.title }); }}>
                <Edit size={14} /> Socials
              </button>
            </div>
          </article>
      ); })() : <p className="dc-empty">Select an email to review its details.</p>} />
  );
};
