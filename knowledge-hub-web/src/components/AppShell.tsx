import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@carbon/react';
import { ChatLaunch, Search, Menu, Tools } from '@carbon/icons-react';
import { FloatingAIChat } from './FloatingAIChat';
import { CommandPalette } from './CommandPalette';
import { TagPanel } from './TagPanel';
import { ProjectsModal } from './ProjectsModal';
import { QuickSparkModal } from './sparks/QuickSparkModal';
import { NavigationMenu } from './NavigationMenu';
import { PRIMARY_DESTINATIONS, TOOL_GROUPS, matchesDestination, selectedTool, type NavigationDestination } from '../navigation/destinations';
import { usePendingTags } from '../hooks/useTaxonomy';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { useAthenaContext } from '../context/AthenaContext';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { api } from '../services/api';

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
  const { data: unsurfacedData } = useQuery({
    queryKey: ['unsurfaced-count'],
    queryFn: () => api.getUnsurfacedClusterCount(),
    refetchInterval: 30_000, staleTime: 30_000,
  });
  const newClusters = unsurfacedData?.success === true && unsurfacedData.data.count > 0;

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
      <Header aria-label="Athena" className="kh-header">
        <Link className="kh-header__brand" to="/" aria-label="Athena home"><span>Richard Hogan</span> Athena</Link>
        <nav className="kh-header__primary" aria-label="Primary navigation">
          {(narrow ? PRIMARY_DESTINATIONS.filter((item) => item.id === 'today') : PRIMARY_DESTINATIONS).map(({ id, path, label, icon: Icon }) => (
            <Link key={id} to={path!} className={`kh-header__destination${primary?.id === id ? ' kh-header__destination--active' : ''}`}
              aria-current={primary?.id === id ? 'page' : undefined}>
              <Icon size={16} />{label}
              {id === 'think' && newClusters && <span className="kh-header__dot" aria-label="New clusters available" />}
            </Link>
          ))}
        </nav>
        <nav className="kh-header__utilities" aria-label="Utility navigation">
          <button type="button" className="kh-header__utility" title="Search (Cmd+K / Ctrl+K)" aria-label="Search"
            onClick={() => { setPaletteOpen(true); setMenu(null); }}><Search size={20} /></button>
          <button type="button" className="kh-header__utility kh-header__athena" title="Open Athena" aria-label="Open Athena"
            onClick={() => { setMenu(null); launchAthena(); }}><ChatLaunch size={20} /><span>Athena</span></button>
          <button type="button" ref={narrow ? mobileRef : toolsRef}
            className={`kh-header__utility${tool || menu ? ' kh-header__utility--active' : ''}`}
            title={narrow ? 'Navigation and Tools' : 'Tools'} aria-label={narrow ? 'Navigation and Tools' : 'Tools'}
            aria-haspopup="menu" aria-expanded={menu !== null} aria-controls={menu ? 'kh-navigation-menu' : undefined}
            onKeyDown={(event) => { menuKey(event, narrow ? 'mobile' : 'tools'); }}
            onClick={() => { setInitialFocus('first'); setMenu((value) => value ? null : narrow ? 'mobile' : 'tools'); }}>
            {narrow ? <Menu size={20} /> : <Tools size={20} />}<span>{narrow ? 'Menu' : 'Tools'}</span>
          </button>
        </nav>
        {menu && <NavigationMenu id="kh-navigation-menu" label={menu === 'mobile' ? 'Navigation and Tools' : 'Tools'}
          groups={menuGroups} selectedId={tool?.id ?? (menu === 'mobile' ? primary?.id : undefined)}
          attentionIds={[...(pendingTags.length > 0 ? ['tags'] : []), ...(newClusters ? ['think'] : [])]}
          onAction={selectAction} onClose={closeMenu} triggerRef={narrow ? mobileRef : toolsRef} initialFocus={initialFocus} />}
      </Header>
      <div className="kh-shell">
        <div className={`kh-content kh-content--shell${tool ? ' kh-content--tools' : ''}`}>
          {tool && <p className="kh-tools-location">Tools / {tool.label}</p>}
          <div className="kh-shell__page"><Outlet /></div>
        </div>
      </div>
      <QuickSparkModal open={sparkModalOpen} onClose={() => { setSparkModalOpen(false); }} />
      <TagPanel open={tagPanelOpen} onClose={() => { setTagPanelOpen(false); }} />
      <ProjectsModal open={projectsOpen} onClose={() => { setProjectsOpen(false); }} />
      {!hasEmbeddedAthena && <FloatingAIChat pageContext={pageContext ?? undefined} />}
      <CommandPalette open={paletteOpen} onClose={() => { setPaletteOpen(false); }} onNavigationAction={selectAction} />
    </>
  );
};
