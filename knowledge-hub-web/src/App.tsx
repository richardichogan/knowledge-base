/**
 * Root App component — sets up routing.
 *
 * Nav structure:
 *   /discover  → DiscoverPage (inbound AI-curated feed)
 *   /plan      → PlanPage     (Calendar + Tasks)
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
import { PasswordGate } from './components/PasswordGate';
import { DiscoverPage } from './pages/DiscoverPage';
import { PlanPage } from './pages/PlanPage';
import { TimelinePage } from './pages/TimelinePage';
import { TasksPage } from './pages/TasksPage';
import { CalendarPage } from './pages/CalendarPage';
import { NotesPage } from './notes/NotesPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { AutocueApp } from './features/autocue/AutocueApp';
import { GraphPage } from './pages/GraphPage';
import { GlobalContextMenuProvider } from './context/GlobalContextMenu';
import { AthenaContextProvider } from './context/AthenaContext';
import { AIChatPage } from './pages/AIChatPage';
import { HomePage } from './pages/HomePage';
import { RepoProjectMappingsPage } from './pages/RepoProjectMappingsPage';

const MyWorkPage: React.FC = () => <TimelinePage excludeSources={['discovered-article', 'email']} />;
const ThinkPage: React.FC = () => <NotesPage />;

const App: React.FC = () => {
  return (
    <PasswordGate>
      <Theme theme="g100" as="div" style={{ minHeight: '100vh' }}>
        <GlobalContextMenuProvider>
          <AthenaContextProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/autocue/*" element={<AutocueApp />} />
              {/* Standalone full-screen chat, no sidebar/nav — for use as a
                  desktop PWA shortcut (Edge/Chrome "install as app"). */}
              <Route path="/chat" element={<AIChatPage standalone />} />
              <Route path="/" element={<AppShell />}>
                <Route index element={<HomePage />} />
                <Route path="discover" element={<DiscoverPage />} />
                <Route path="plan"     element={<PlanPage />} />
                <Route path="my-work"  element={<MyWorkPage />} />
                <Route path="think"    element={<ThinkPage />} />
                <Route path="library"  element={<DocumentsPage />} />
                <Route path="graph"    element={<GraphPage />} />
                <Route path="settings/repo-mappings" element={<RepoProjectMappingsPage />} />
                <Route path="timeline"  element={<Navigate to="/discover" replace />} />
                <Route path="search"    element={<Navigate to="/discover" replace />} />
                <Route path="ai"        element={<Navigate to="/discover" replace />} />
                <Route path="tasks"     element={<Navigate to="/plan" replace />} />
                <Route path="calendar"  element={<Navigate to="/plan" replace />} />
                <Route path="notes"     element={<Navigate to="/think" replace />} />
                <Route path="projects"  element={<Navigate to="/discover" replace />} />
                <Route path="documents" element={<Navigate to="/library" replace />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
          </AthenaContextProvider>
        </GlobalContextMenuProvider>
      </Theme>
    </PasswordGate>
  );
};

export default App;
