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
 * AI Chat is a persistent slide-over panel triggered from the header.
 * Search is Cmd+K (command palette — not yet implemented).
 */

import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Header,
  HeaderName,
  HeaderMenuButton,
  HeaderGlobalBar,
  HeaderGlobalAction,
  SideNav,
  SideNavItems,
  SideNavLink,
  Content,
} from '@carbon/react';
import {
  Compass,
  CalendarTools,
  Portfolio,
  Idea,
  Book,
  Ai,
  Tag,
  Folder,
} from '@carbon/icons-react';
import { AIChatPage } from '../pages/AIChatPage';
import { CommandPalette } from './CommandPalette';
import { TagPanel } from './TagPanel';
import { ProjectsModal } from './ProjectsModal';
import { usePendingTags } from '../hooks/useTaxonomy';

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/discover', label: 'Discover', icon: Compass },
  { path: '/plan',     label: 'Plan',     icon: CalendarTools },
  { path: '/my-work',  label: 'My Work',  icon: Portfolio },
  { path: '/think',    label: 'Think',    icon: Idea },
  { path: '/library',  label: 'Library',  icon: Book },
];

export const AppShell: React.FC = () => {
  const [isSideNavExpanded, setIsSideNavExpanded] = useState(true);
  const [aiPanelOpen, setAiPanelOpen]             = useState(false);
  const [tagPanelOpen, setTagPanelOpen]           = useState(false);
  const [projectsOpen, setProjectsOpen]           = useState(false);
  const [paletteOpen, setPaletteOpen]             = useState(false);
  const navigate  = useNavigate();
  const location  = useLocation();
  const { data: pendingTags = [] } = usePendingTags();

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

  return (
    <>
      <Header aria-label="Knowledge Hub">
        <HeaderMenuButton
          aria-label={isSideNavExpanded ? 'Close menu' : 'Open menu'}
          onClick={() => setIsSideNavExpanded((v) => !v)}
          isActive={isSideNavExpanded}
        />
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
            aria-label="AI Chat"
            isActive={aiPanelOpen}
            onClick={() => { setAiPanelOpen((v) => !v); }}
          >
            <Ai size={20} />
          </HeaderGlobalAction>
        </HeaderGlobalBar>
      </Header>

      <SideNav
        aria-label="Side navigation"
        expanded={isSideNavExpanded}
        isPersistent={false}
      >
        <SideNavItems>
          {NAV_ITEMS.map(({ path, label, icon }) => {
            const isActive = location.pathname === path || location.pathname.startsWith(path + '/');
            return (
              <SideNavLink
                key={path}
                renderIcon={icon}
                href={path}
                isActive={isActive}
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  void navigate(path);
                }}
              >
                {label}
              </SideNavLink>
            );
          })}
        </SideNavItems>
      </SideNav>

      <Content>
        <Outlet />
      </Content>

      {/* ── Tag Manager slide-over ── */}
      <TagPanel open={tagPanelOpen} onClose={() => { setTagPanelOpen(false); }} />

      {/* ── Projects slide-over ── */}
      <ProjectsModal open={projectsOpen} onClose={() => { setProjectsOpen(false); }} />

      {/* ── AI Chat slide-over panel ── */}
      {aiPanelOpen && (
        <div className="ai-slideover">
          <div className="ai-slideover__backdrop" onClick={() => { setAiPanelOpen(false); }} />
          <div className="ai-slideover__panel">
            <AIChatPage />
          </div>
        </div>
      )}

      {/* ── Cmd+K command palette ── */}
      <CommandPalette open={paletteOpen} onClose={() => { setPaletteOpen(false); }} />
    </>
  );
};
