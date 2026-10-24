import React from 'react';
import { AppDialog } from './AppDialog';
import { deferredView } from '../utils/deferredView';
import type { SettingsView } from '../navigation/settings';

const Memory = deferredView('Memory', async () => ({ default: (await import('../pages/MemoryPage')).MemoryPage }));
const Connections = deferredView('Connections and sync', async () => ({ default: (await import('../pages/TimelinePage')).TimelinePage }));
const RepoMappings = deferredView('Repo project mappings', async () => ({ default: (await import('../pages/RepoProjectMappingsPage')).RepoProjectMappingsPage }));

const TITLES: Record<SettingsView, string> = {
  memory: 'Memory', sync: 'Connections and sync', 'repo-projects': 'Repo project mappings',
};

export function SettingsDialog({ view, onClose }: { view: SettingsView; onClose: () => void }): React.ReactElement {
  return <AppDialog title={TITLES[view]} onClose={onClose} settings actions={
    <button type="button" className="kh-dialog__button" onClick={onClose}>Done</button>
  }>
    {view === 'memory' && <Memory embedded />}
    {view === 'sync' && <Connections settingsOnly />}
    {view === 'repo-projects' && <RepoMappings embedded />}
  </AppDialog>;
}
