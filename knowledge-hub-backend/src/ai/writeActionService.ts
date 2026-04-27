import { getDb } from '../db/db.js';
import { markSocialPushSent, assertValidPlatform } from '../integrations/cms/socialPushUpdater.js';
import { reindexPost } from '../integrations/cms/postIndexer.js';
import { createTodoTask } from '../integrations/graph/todoSync.js';
import { createGitHubIssue } from '../integrations/github/issuesSync.js';
import { uploadBlobAsText } from '../integrations/cms/blobClient.js';
import { env } from '../config/env.js';
import { WriteActionNotConfirmedError } from '../types/errors.js';
import type {
  WriteActionProposal,
  WriteActionType,
  WriteActionPayload,
  CmsUpdateSocialPushPayload,
  TodoCreateTaskPayload,
  GithubCreateIssuePayload,
  BlobSaveMarkdownPayload,
} from '../types/aiContext.js';

/**
 * In-memory store for pending write action proposals.
 * In production, persist to PostgreSQL — in-memory is sufficient for v0.1.
 */
const pendingProposals = new Map<string, WriteActionProposal>();

/**
 * Creates a write action proposal and stores it server-side.
 * The proposal is returned to the client for display and confirmation.
 * Nothing is executed until confirmWriteAction is called.
 */
export function proposeWriteAction(
  sessionId: string,
  actionType: WriteActionType,
  description: string,
  payload: WriteActionPayload,
): WriteActionProposal {
  const id = `wa-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const proposal: WriteActionProposal = {
    id,
    sessionId,
    actionType,
    description,
    payload,
    proposedAt: new Date().toISOString(),
    status: 'pending',
  };
  pendingProposals.set(id, proposal);
  return proposal;
}

/**
 * Executes a write action after explicit user confirmation.
 * All write actions require confirmation — spec requirement.
 * @throws WriteActionNotConfirmedError if proposal not found or already actioned.
 */
export async function confirmWriteAction(proposalId: string): Promise<void> {
  const proposal = pendingProposals.get(proposalId);

  if (!proposal || proposal.status !== 'pending') {
    throw new WriteActionNotConfirmedError();
  }

  proposal.status = 'executed';
  pendingProposals.set(proposalId, proposal);

  await executeWriteAction(proposal.payload);
}

/** Cancels a pending write action proposal. */
export function cancelWriteAction(proposalId: string): void {
  const proposal = pendingProposals.get(proposalId);
  if (proposal && proposal.status === 'pending') {
    proposal.status = 'cancelled';
    pendingProposals.set(proposalId, proposal);
  }
}

/** Returns all pending proposals for a session. */
export function getPendingProposals(sessionId: string): WriteActionProposal[] {
  return Array.from(pendingProposals.values()).filter(
    (p) => p.sessionId === sessionId && p.status === 'pending',
  );
}

async function executeWriteAction(payload: WriteActionPayload): Promise<void> {
  const db = getDb();

  switch (payload.type) {
    case 'cms-update-social-push': {
      const p = payload as CmsUpdateSocialPushPayload;
      assertValidPlatform(p.platform);
      await markSocialPushSent(p.postId, p.platform);
      await reindexPost(db, p.postId);
      break;
    }
    case 'todo-create-task': {
      const p = payload as TodoCreateTaskPayload;
      await createTodoTask({
        title: p.title,
        ...(p.body !== undefined && { body: p.body }),
        ...(p.dueDateTime !== undefined && { dueDateTime: p.dueDateTime }),
        ...(p.listName !== undefined && { listName: p.listName }),
      });
      break;
    }
    case 'github-create-issue': {
      const p = payload as GithubCreateIssuePayload;
      await createGitHubIssue(p.repo, p.title, p.body, p.labels);
      break;
    }
    case 'blob-save-markdown': {
      const p = payload as BlobSaveMarkdownPayload;
      await uploadBlobAsText(
        env.CMS_BLOB_CONTAINER,
        p.filename,
        p.content,
        'text/markdown',
      );
      break;
    }
    case 'cms-publish-post':
      // Full post publish — placeholder for v0.2
      throw new Error('cms-publish-post not yet implemented');
    default:
      throw new Error(`Unknown write action type`);
  }
}
