/**
 * components/SideTabsPanel.tsx — the tabbed right-hand panel used beside a
 * document (Library; same look and behaviour as Think's side panel):
 * drag-resizable, collapsible to a slim strip (⌘J / Ctrl+J), remembers its
 * width, open tab and collapsed state per `storageKey`.
 *
 * Tabs marked `keepMounted` stay mounted while hidden (Athena, so an
 * in-flight reply and the thread's scroll position survive tab switches).
 */
import React, { useEffect } from 'react';
import { SidePanelClose, SidePanelOpen } from '@carbon/icons-react';
import { PaneResizer } from './PaneResizer';
import { usePersistedBoolean, usePersistedChoice, usePersistedPaneWidth } from '../hooks/usePersistedState';
import type { PaneWidthOptions } from '../hooks/usePersistedState';

export interface SideTab {
  id: string;
  label: string;
  content: React.ReactNode;
  /** Keep mounted (hidden) when another tab is active. */
  keepMounted?: boolean;
  /** Small status dot before the label; `busy` pulses. */
  dot?: 'idle' | 'busy';
  /** Fill the panel height and let the content manage its own scrolling. */
  fill?: boolean;
}

interface SideTabsPanelProps {
  /** Prefix for persisted state, e.g. 'library-side'. */
  storageKey: string;
  tabs: SideTab[];
  defaultTab: string;
  width: PaneWidthOptions;
  label: string;
  /** Switch to a tab from outside (e.g. Preview when a card is opened); bump `seq` to re-request. */
  selectTab?: { id: string; seq: number } | undefined;
  /** Start collapsed until the user (or selectTab) opens it. */
  defaultCollapsed?: boolean;
}

export const SideTabsPanel: React.FC<SideTabsPanelProps> = ({ storageKey, tabs, defaultTab, width: widthOptions, label, selectTab, defaultCollapsed = false }) => {
  const tabIds = tabs.map((t) => t.id);
  const [storedTab, setTab] = usePersistedChoice<string>(`kh_${storageKey}_tab`, tabIds, defaultTab);
  const tab = tabIds.includes(storedTab) ? storedTab : (tabIds[0] ?? defaultTab);
  const [collapsed, setCollapsed] = usePersistedBoolean(`kh_${storageKey}_collapsed`, defaultCollapsed);
  const [width, setWidth] = usePersistedPaneWidth(storageKey, widthOptions);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [setCollapsed]);

  useEffect(() => {
    if (selectTab === undefined) return;
    setTab(selectTab.id);
    setCollapsed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectTab?.seq]);

  const busyTab = tabs.find((t) => t.dot === 'busy');

  return (
    <>
      {collapsed ? (
        <div className="think-side-strip">
          <button
            type="button"
            className="think-side-strip__btn"
            title="Open side panel (⌘J)"
            aria-label="Open side panel"
            onClick={() => { setCollapsed(false); }}
          >
            <SidePanelOpen size={16} className="think-side-strip__icon" />
          </button>
          {tabs.some((t) => t.dot !== undefined) && (
            <span className={`think-athena-status__dot${busyTab ? ' think-athena-status__dot--busy' : ''}`} />
          )}
        </div>
      ) : (
        <PaneResizer width={width} onResize={setWidth} side="right" label="Resize side panel" />
      )}
      <div
        className="notes-meta-panel side-tabs-panel"
        hidden={collapsed}
        style={{ width: `${String(width)}px`, minWidth: `${String(width)}px` }}
      >
        <div className="notes-meta-tabs" role="tablist" aria-label={label}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${storageKey}-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${storageKey}-panel-${t.id}`}
              className={`notes-meta-tab${tab === t.id ? ' notes-meta-tab--active' : ''}`}
              onClick={() => { setTab(t.id); }}
            >
              {t.dot !== undefined && (
                <span className={`think-athena-status__dot${t.dot === 'busy' ? ' think-athena-status__dot--busy' : ''}`} />
              )}
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className="notes-meta-tabs__collapse"
            title="Collapse side panel (⌘J)"
            aria-label="Collapse side panel"
            onClick={() => { setCollapsed(true); }}
          >
            <SidePanelClose size={16} />
          </button>
        </div>

        {tabs.map((t) => {
          const active = tab === t.id;
          if (!active && !t.keepMounted) return null;
          return (
            <div
              key={t.id}
              role="tabpanel"
              id={`${storageKey}-panel-${t.id}`}
              aria-labelledby={`${storageKey}-tab-${t.id}`}
              className={`notes-meta-tabpanel${t.fill ? ' notes-meta-tabpanel--athena' : ''}`}
              hidden={!active}
            >
              {t.content}
            </div>
          );
        })}
      </div>
    </>
  );
};
