/**
 * AppShell — Carbon UI Shell with Header + SideNav + Content area.
 *
 * Nav structure (job-based):
 *   Discover   — AI-curated inbound content feed
 *   Plan       — Calendar + Tasks (M365 + Planner)
 *   My Work    — Output feed (commits, posts, completed tasks)
 *   Think      — Notes + Canvas scratchpad
 *   Library    — Formal markdown document library
 *
 * AI Chat is a floating popup widget in the bottom-right corner.
 * Search is Cmd+K (command palette — not yet implemented).
 */

import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Header,
  HeaderName,
  HeaderGlobalBar,
  HeaderGlobalAction,
} from '@carbon/react';
import {
  Compass,
  CalendarTools,
  Portfolio,
  Idea,
  Book,
  Tag,
  Folder,
  Flash,
  Network_3,
} from '@carbon/icons-react';
import { FloatingAIChat } from './FloatingAIChat';
import { CommandPalette } from './CommandPalette';
import { TagPanel } from './TagPanel';
import { ProjectsModal } from './ProjectsModal';
import { QuickSparkModal } from './sparks/QuickSparkModal';
import { usePendingTags } from '../hooks/useTaxonomy';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { api } from '../services/api';

interface NavItem {
  path: string;
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: React.ComponentType<any>;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/discover', label: 'Discover', icon: Compass },
  { path: '/plan',     label: 'Plan',     icon: CalendarTools },
  { path: '/my-work',  label: 'My Work',  icon: Portfolio },
  { path: '/think',    label: 'Think',    icon: Idea },
  { path: '/library',  label: 'Library',  icon: Book },
];

export const AppShell: React.FC = () => {
  const [tagPanelOpen, setTagPanelOpen]   = useState(false);
  const [projectsOpen, setProjectsOpen]   = useState(false);
  const [paletteOpen, setPaletteOpen]     = useState(false);
  const [sparkModalOpen, setSparkModalOpen] = useState(false);
  const navigate  = useNavigate();
  const location  = useLocation();
  const { data: pendingTags = [] } = usePendingTags();

  // Poll for unsurfaced spark clusters to show the Think nav dot
  const { data: unsurfacedData } = useQuery({
    queryKey: ['unsurfaced-count'],
    queryFn: () => api.getUnsurfacedClusterCount(),
    refetchInterval: 30_000,
    staleTime: 30_000,
  });
  const unsurfacedCount = unsurfacedData?.success ? unsurfacedData.data.count : 0;

  // Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); };
  }, []);

  // Cmd+. — open quick spark capture
  useGlobalShortcuts({ onSparkCapture: () => { setSparkModalOpen(true); } });

  return (
    <>
      <Header aria-label="Knowledge Hub">
        <HeaderName href="/discover" prefix="Richard Hogan">
          Knowledge Hub
        </HeaderName>
        <HeaderGlobalBar>
          <HeaderGlobalAction
            aria-label="Projects"
            isActive={projectsOpen}
            onClick={() => { setProjectsOpen((v) => !v); setTagPanelOpen(false); }}
          >
            <Folder size={20} />
          </HeaderGlobalAction>
          <HeaderGlobalAction
            aria-label="Tag Manager"
            isActive={tagPanelOpen}
            onClick={() => { setTagPanelOpen((v) => !v); setProjectsOpen(false); }}
            className="header-action-tag"
          >
            <span className="header-action-icon-wrap">
              <Tag size={20} />
              {pendingTags.length > 0 && (
                <span className="header-badge">{pendingTags.length}</span>
              )}
            </span>
          </HeaderGlobalAction>
          <HeaderGlobalAction
            aria-label="New Spark"
            isActive={sparkModalOpen}
            onClick={() => { setSparkModalOpen((v) => !v); }}
          >
            <Flash size={20} />
          </HeaderGlobalAction>
          <HeaderGlobalAction
            aria-label="Knowledge Graph"
            isActive={location.pathname === '/graph'}
            onClick={() => { void navigate('/graph'); }}
          >
            <Network_3 size={20} />
          </HeaderGlobalAction>
        </HeaderGlobalBar>
      </Header>

      {/* ── Shell: sits below Carbon's fixed header, fills remaining viewport ── */}
      <div className="kh-shell">

        <nav className="kh-topnav" aria-label="Main navigation">
          {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
            const isActive = location.pathname === path || location.pathname.startsWith(path + '/');
            const showDot = path === '/think' && unsurfacedCount > 0;
            return (
              <button
                key={path}
                className={`kh-topnav__item${isActive ? ' kh-topnav__item--active' : ''}`}
                onClick={() => { void navigate(path); }}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={16} />
                {label}
                {showDot && <span className="kh-topnav__dot" aria-label="New clusters available" />}
              </button>
            );
          })}
        </nav>

        <div className="kh-content">
          <Outlet />
        </div>

      </div>

      {/* ── Quick Spark modal ── */}
      <QuickSparkModal open={sparkModalOpen} onClose={() => { setSparkModalOpen(false); }} />

      {/* ── Tag Manager slide-over ── */}
      <TagPanel open={tagPanelOpen} onClose={() => { setTagPanelOpen(false); }} />

      {/* ── Projects slide-over ── */}
      <ProjectsModal open={projectsOpen} onClose={() => { setProjectsOpen(false); }} />

      {/* ── AI Chat floating widget ── */}
      <FloatingAIChat />

      {/* ── Cmd+K command palette ── */}
      <CommandPalette open={paletteOpen} onClose={() => { setPaletteOpen(false); }} />
    </>
  );
};
