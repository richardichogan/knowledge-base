import { api } from '../services/api';
import type { GitHubPushPayload, GitHubPublication } from './types';

export async function pushToGitHub(payload: GitHubPushPayload): Promise<GitHubPublication> {
  const result = await api.publishNoteToGitHub(payload);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}
