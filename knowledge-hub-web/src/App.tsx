/**
 * Root App component — sets up routing.
 *
 * Nav structure:
 *   /discover  → DiscoverPage (inbound AI-curated feed)
 *   /plan      → PlanPage     (task board + list)
 *   /my-work   → MyWorkPage   (output feed)
 *   /think     → ThinkPage    (Notes)
 *   /library   → DocumentsPage
 *
 * AI Chat lives in a slide-over panel in AppShell (not a route), plus a
 * standalone full-screen route at /chat (no sidebar/nav) for use as a
 * desktop PWA shortcut (see docs/local-chat-app.md).
 * Old routes redirect to preserve any bookmarks.
 */

import React from 'react';
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import { Theme } from '@carbon/react';
import { AppShell } from './components/AppShell';
import { SignInGate } from './components/SignInGate';
import { NotFoundPage } from './pages/NotFoundPage';
import { GlobalContextMenuProvider } from './context/GlobalContextMenu';
import { AthenaContextProvider } from './context/AthenaContext';
import { HomePage } from './pages/HomePage';
import { AppDialogHost } from './components/AppDialog';
import { LocalFolderSync } from './components/library/LocalFoldersPanel';
import { deferredView } from './utils/deferredView';

const DiscoverPage = deferredView('Discover', async () => ({ default: (await import('./pages/DiscoverPage')).DiscoverPage }));
const PlanPage = deferredView('Plan', async () => ({ default: (await import('./pages/PlanPage')).PlanPage }));
const TimelinePage = deferredView('Activity', async () => ({ default: (await import('./pages/TimelinePage')).TimelinePage }));
const NotesPage = deferredView('Think', async () => ({ default: (await import('./notes/NotesPage')).NotesPage }));
const NotePopout = deferredView('Note', async () => ({ default: (await import('./notes/NotePopout')).NotePopout }));
const DocumentsPage = deferredView('Library', async () => ({ default: (await import('./pages/DocumentsPage')).DocumentsPage }));
const MemoryPage = deferredView('Memory', async () => ({ default: (await import('./pages/MemoryPage')).MemoryPage }));
const AutocueApp = deferredView('Autocue', async () => ({ default: (await import('./features/autocue/AutocueApp')).AutocueApp }));
const GraphPage = deferredView('Graph', async () => ({ default: (await import('./pages/GraphPage')).GraphPage }));
const AIChatPage = deferredView('Athena', async () => ({ default: (await import('./pages/AIChatPage')).AIChatPage }));
const RepoProjectMappingsPage = deferredView('Project mappings', async () => ({ default: (await import('./pages/RepoProjectMappingsPage')).RepoProjectMappingsPage }));
const ProjectsPage = deferredView('Projects', async () => ({ default: (await import('./pages/ProjectsPage')).ProjectsPage }));
const BuildPage = deferredView('Build', async () => ({ default: (await import('./features/build/BuildPage')).BuildPage }));
const KnowledgeHealthPage = deferredView('Knowledge health', async () => ({ default: (await import('./pages/KnowledgeHealthPage')).KnowledgeHealthPage }));

const MyWorkPage: React.FC = () => <TimelinePage excludeSources={['discovered-article', 'email']} />;
const ThinkPage: React.FC = () => <NotesPage />;

const App: React.FC = () => {
  return (
    <SignInGate>
      <Theme theme="g100" as="div" style={{ minHeight: '100vh' }}>
        <AppDialogHost />
        <LocalFolderSync />
        <AthenaContextProvider>
          <BrowserRouter>
            <GlobalContextMenuProvider>
            <Routes>
              <Route path="/autocue/*" element={<AutocueApp />} />
              {/* Standalone full-screen chat, no sidebar/nav — for use as a
                  desktop PWA shortcut (Edge/Chrome "install as app"). */}
              <Route path="/chat" element={<AIChatPage standalone />} />
              <Route path="/think/notes/:noteId/popout" element={<NotePopout />} />
              <Route path="/" element={<AppShell />}>
                <Route index element={<HomePage />} />
                <Route path="discover" element={<DiscoverPage />} />
                <Route path="plan"     element={<PlanPage />} />
                <Route path="my-work"  element={<MyWorkPage />} />
                <Route path="think"    element={<ThinkPage />} />
                <Route path="library"  element={<DocumentsPage />} />
          <Route path="build"    element={<BuildPage />} />
                <Route path="memory"   element={<MemoryPage />} />
                <Route path="blog-post" element={<Navigate to="/chat" replace />} />
                <Route path="graph"    element={<GraphPage />} />
                <Route path="settings/repo-mappings" element={<RepoProjectMappingsPage />} />
                <Route path="health" element={<KnowledgeHealthPage />} />
                <Route path="timeline"  element={<Navigate to="/discover" replace />} />
                <Route path="search"    element={<Navigate to="/discover" replace />} />
                <Route path="ai"        element={<Navigate to="/discover" replace />} />
                <Route path="tasks"     element={<Navigate to="/plan" replace />} />
                <Route path="calendar"  element={<Navigate to="/plan" replace />} />
                <Route path="notes"     element={<Navigate to="/think" replace />} />
                <Route path="projects"  element={<ProjectsPage />} />
                <Route path="documents" element={<Navigate to="/library" replace />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
            </GlobalContextMenuProvider>
          </BrowserRouter>
        </AthenaContextProvider>
      </Theme>
    </SignInGate>
  );
};

export default App;
