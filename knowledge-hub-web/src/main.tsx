/**
 * App entry point — mounts React into #root.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles/global.scss';

// Unregister any stale service workers — they cause blank-page / fetch-fail issues
// when the dev server port changes between sessions.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister();
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,        // data is fresh for 5 minutes
      gcTime: 10 * 60_000,          // keep in cache for 10 minutes
      retry: 1,                     // 1 retry only — fail fast, don't spin forever
      retryDelay: 1_000,            // fixed 1s delay before retry
      refetchOnWindowFocus: false,  // don't refetch just because user clicks the tab
      refetchOnReconnect: false,    // don't refetch on network reconnect
    },
  },
});

const root = document.getElementById('root');
if (root === null) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
