/**
 * React context providing a shared KnowledgeHubApi instance
 * to the entire app. The base URL and token are loaded from
 * env/config so no credentials are hardcoded.
 */

import React, {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
} from 'react';
import { KnowledgeHubApi } from './api';

// These values are injected at build time via a local .env file
// (react-native-config or inline constant for development).
// In production the values come from the build pipeline.
const API_BASE_URL: string = process.env['KNOWLEDGE_HUB_API_URL'] ?? 'http://10.0.2.2:3000';
const API_TOKEN: string = process.env['KNOWLEDGE_HUB_API_TOKEN'] ?? '';

const ApiClientContext = createContext<KnowledgeHubApi | null>(null);

/**
 * Wraps the app and makes the API client available via `useApiClient()`.
 */
export const ApiClientProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const api = useMemo(
    () => new KnowledgeHubApi(API_BASE_URL, API_TOKEN),
    [],
  );

  return (
    <ApiClientContext.Provider value={api}>
      {children}
    </ApiClientContext.Provider>
  );
};

/**
 * Returns the shared KnowledgeHubApi instance.
 * Must be used inside `<ApiClientProvider>`.
 */
export function useApiClient(): KnowledgeHubApi {
  const ctx = useContext(ApiClientContext);
  if (ctx === null) {
    throw new Error('useApiClient must be used within ApiClientProvider');
  }
  return ctx;
}
