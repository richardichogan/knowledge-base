/**
 * notes/githubSync.ts — GitHub push service.
 *
 * TODO: Wire up the GitHub API integration.
 *       This stub should be replaced with a call to the backend's
 *       GitHub API integration once it is built. The backend should
 *       accept { markdown, filePath, commitMessage } and create/update
 *       the file in the configured content repository.
 */

import type { GitHubPushPayload } from './types';

export interface GitHubPushResult {
  success: boolean;
  commitUrl?: string;
  error?: string;
}

/**
 * Push document content to GitHub as a markdown file.
 * Currently stubbed — logs the payload and returns a mock success response.
 */
export async function pushToGitHub(payload: GitHubPushPayload): Promise<GitHubPushResult> {
  // TODO: Replace with real GitHub API call via backend endpoint
  // e.g. POST /api/github/push { markdown, filePath, commitMessage }
  console.log('[githubSync] pushToGitHub called (stub):', {
    filePath: payload.filePath,
    commitMessage: payload.commitMessage,
    markdownLength: payload.markdown.length,
  });

  // Simulate network delay
  await new Promise<void>((resolve) => { setTimeout(resolve, 800); });

  return {
    success: true,
    commitUrl: `https://github.com/stub-repo/commit/stub-sha`,
  };
}
