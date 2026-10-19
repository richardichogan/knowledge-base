import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@carbon/react';
import { ChatLaunch, Search, Menu, Tools, Idea, DocumentAdd, Time, WarningAlt } from '@carbon/icons-react';
import type { CarbonIconType } from '@carbon/icons-react';
import type { NavAttention } from '../services/api';
import { FloatingAIChat } from './FloatingAIChat';
import { CommandPalette } from './CommandPalette';
import { TagPanel } from './TagPanel';
import { ProjectsModal } from './ProjectsModal';
import { QuickSparkModal } from './sparks/QuickSparkModal';
import { NavigationMenu } from './NavigationMenu';
import { DayCheckinBanner } from '../features/plan/DayCheckin';
import { PodcastPrepNotification } from './today/PodcastPrepCard';
import { PRIMARY_DESTINATIONS, TOOL_GROUPS, matchesDestination, selectedTool, type NavigationDestination } from '../navigation/destinations';
import { usePendingTags } from '../hooks/useTaxonomy';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { useAthenaContext } from '../context/AthenaContext';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { api } from '../services/api';

const DISCOVER_SEEN_KEY = 'kh-discover-seen';

/** Last Discover visit; the first ever load starts the clock now rather than flagging the whole backlog. */
function discoverSeenAt(): string {
  const saved = localStorage.getItem(DISCOVER_SEEN_KEY);
  if (saved) return saved;
  const now = new Date().toISOString();
  localStorage.setItem(DISCOVER_SEEN_KEY, now);
  return now;
}

function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type BadgeTab = keyof NavAttention;
const BADGES: Record<BadgeTab, { icon: CarbonIconType; label: (n: number) => string }> = {
  think: { icon: Idea, label: (n) => `${n} new spark theme${n === 1 ? '' : 's'}` },
  discover: { icon: DocumentAdd, label: (n) => `${n} new article${n === 1 ? '' : 's'} to review since your last visit` },
  plan: { icon: Time, label: (n) => `${n} overdue task${n === 1 ? '' : 's'}` },
  build: { icon: WarningAlt, label: (n) => `${n} build task${n === 1 ? '' : 's'} waiting on you` },
};
const isBadgeTab = (id: string): id is BadgeTab => Object.hasOwn(BADGES, id);

function NavBadge({ id, count }: { id: string; count: number }): React.ReactElement | null {
  if (count <= 0 || !isBadgeTab(id)) return null;
  const { icon: Icon, label } = BADGES[id];
  return <span className={`kh-header__badge kh-header__badge--${id}`} title={label(count)} aria-label={label(count)}>
    <Icon size={12} aria-hidden="true" />{count > 99 ? '99+' : count}
  </span>;
}

export const AppShell: React.FC = () => {
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sparkModalOpen, setSparkModalOpen] = useState(false);
  const [menu, setMenu] = useState<'tools' | 'mobile' | null>(null);
  const [initialFocus, setInitialFocus] = useState<'first' | 'last'>('first');
  const toolsRef = useRef<HTMLButtonElement>(null);
  const mobileRef = useRef<HTMLButtonElement>(null);
  const narrow = useMediaQuery('(max-width: 1100px)');
  const location = useLocation();
  const { data: pendingTags = [] } = usePendingTags();
  const { pageContext, hasEmbeddedAthena, launchAthena } = useAthenaContext();
  const tool = selectedTool(location.pathname, location.search);
  const primary = PRIMARY_DESTINATIONS.find((item) => item.path && matchesDestination(location.pathname, item.path));
  const isThink = matchesDestination(location.pathname, '/think');
  const onDiscover = matchesDestination(location.pathname, '/discover');
  // Prefix 'unsurfaced-count' so the existing spark invalidations refresh these badges too.
  const { data: attentionData, refetch: refetchAttention } = useQuery({
    queryKey: ['unsurfaced-count', 'nav-attention'],
    queryFn: () => api.getNavAttention(discoverSeenAt(), localDay()),
    refetchInterval: 30_000, staleTime: 30_000,
  });
  useEffect(() => {
    if (!onDiscover) return;
    localStorage.setItem(DISCOVER_SEEN_KEY, new Date().toISOString());
    void refetchAttention();
  }, [onDiscover, refetchAttention]);
  const attention: NavAttention | null = attentionData?.success === true ? attentionData.data : null;
  const badgeCount = (id: string): number => (attention && isBadgeTab(id) ? attention[id] : 0);
  const newClusters = badgeCount('think') > 0;

  const closeMenu = useCallback((restoreFocus: boolean): void => {
    setMenu(null);
    if (restoreFocus) (narrow ? mobileRef : toolsRef).current?.focus();
  }, [narrow]);
  useEffect(() => { setMenu(null); }, [location.pathname, location.search, narrow]);
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setMenu(null);
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); };
  }, []);
  useGlobalShortcuts({ onSparkCapture: () => { setSparkModalOpen(true); } });

  function selectAction(item: NavigationDestination): void {
    closeMenu(true);
    if (item.action === 'tags') { setTagPanelOpen(true); setProjectsOpen(false); }
    if (item.action === 'repo-tags') { setProjectsOpen(true); setTagPanelOpen(false); }
  }
  function menuKey(event: React.KeyboardEvent<HTMLButtonElement>, type: 'tools' | 'mobile'): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setInitialFocus(event.key === 'ArrowUp' ? 'last' : 'first');
      setMenu(type);
    }
  }
  const menuGroups = menu === 'mobile'
    ? [{ label: 'Main', items: PRIMARY_DESTINATIONS }, ...TOOL_GROUPS.map((group) => ({ ...group, label: `Tools / ${group.label}` }))]
    : TOOL_GROUPS;

  return (
    <>
      <a className="kh-skip-link" href="#kh-main-content">Skip to content</a>
      <Header aria-label="Athena" className="kh-header">
        <Link className="kh-header__brand" to="/" aria-label="Athena home">
          Athena
        </Link>
        <nav className="kh-header__primary" aria-label="Primary navigation">
          {(narrow ? PRIMARY_DESTINATIONS.filter((item) => item.id === 'today') : PRIMARY_DESTINATIONS).map(({ id, path, label, icon: Icon }) => (
            <Link key={id} to={path!} className={`kh-header__destination${primary?.id === id ? ' kh-header__destination--active' : ''}`}
              aria-current={primary?.id === id ? 'page' : undefined}>
              <Icon size={16} />{label}
              <NavBadge id={id} count={badgeCount(id)} />
            </Link>
          ))}
        </nav>
        <nav className="kh-header__utilities" aria-label="Utility navigation">
          <button type="button" className="kh-header__utility" title="Search (Cmd+K / Ctrl+K)" aria-label="Search"
            onClick={() => { setPaletteOpen(true); setMenu(null); }}><Search size={20} /></button>
          <button type="button" className="kh-header__utility kh-header__athena"
            title={isThink && !hasEmbeddedAthena ? 'Open a note or canvas to use Athena' : 'Open Athena'} aria-label="Open Athena" disabled={isThink && !hasEmbeddedAthena}
            onClick={() => { setMenu(null); launchAthena(); }}><ChatLaunch size={20} /></button>
          <button type="button" ref={narrow ? mobileRef : toolsRef}
            className={`kh-header__utility${tool || menu ? ' kh-header__utility--active' : ''}`}
            title={narrow ? 'Navigation and Tools' : 'Tools'} aria-label={narrow ? 'Navigation and Tools' : 'Tools'}
            aria-haspopup="menu" aria-expanded={menu !== null} aria-controls={menu ? 'kh-navigation-menu' : undefined}
            onKeyDown={(event) => { menuKey(event, narrow ? 'mobile' : 'tools'); }}
            onClick={() => { setInitialFocus('first'); setMenu((value) => value ? null : narrow ? 'mobile' : 'tools'); }}>
            {narrow ? <Menu size={20} /> : <Tools size={20} />}
          </button>
        </nav>
        {menu && <NavigationMenu id="kh-navigation-menu" label={menu === 'mobile' ? 'Navigation and Tools' : 'Tools'}
          groups={menuGroups} selectedId={tool?.id ?? (menu === 'mobile' ? primary?.id : undefined)}
          attentionIds={[...(pendingTags.length > 0 ? ['tags'] : []), ...(newClusters ? ['think'] : []),
            ...(['discover', 'plan', 'build'] as const).filter((tab) => badgeCount(tab) > 0)]}
          renderBadge={(itemId) => NavBadge({ id: itemId, count: badgeCount(itemId) })}
          onAction={selectAction} onClose={closeMenu} triggerRef={narrow ? mobileRef : toolsRef} initialFocus={initialFocus} />}
      </Header>
      <div className="kh-shell">
        <div className={`kh-content kh-content--shell${tool ? ' kh-content--tools' : ''}`}>
          {tool && <p className="kh-tools-location">Tools / {tool.label}</p>}
          <DayCheckinBanner />
          <PodcastPrepNotification />
          <div className="kh-shell__page" id="kh-main-content" tabIndex={-1}><Outlet /></div>
        </div>
      </div>
      <QuickSparkModal open={sparkModalOpen} onClose={() => { setSparkModalOpen(false); }} />
      <TagPanel open={tagPanelOpen} onClose={() => { setTagPanelOpen(false); }} />
      <ProjectsModal open={projectsOpen} onClose={() => { setProjectsOpen(false); }} />
      {!isThink && !hasEmbeddedAthena && <FloatingAIChat pageContext={pageContext ?? undefined} />}
      <CommandPalette open={paletteOpen} onClose={() => { setPaletteOpen(false); }} onNavigationAction={selectAction}
        onSparkCapture={() => { setSparkModalOpen(true); }}
        onAskAthena={isThink && !hasEmbeddedAthena ? undefined : launchAthena} />
    </>
  );
};
