/**
 * build/githubAgents.ts
 * GitHub calls used by the Build pipeline: create an issue assigned to a cloud
 * coding agent (Copilot or the Claude partner agent), find the PR it opens,
 * read checks, merge, comment and tidy up the branch.
 *
 * Agent assignment uses the GraphQL `agentAssignment` input, which needs the
 * preview feature header below. The agent's bot id is discovered per repo via
 * `suggestedActors(capabilities: [CAN_BE_ASSIGNED])` — the agent must be
 * enabled for the repo (Claude also needs the partner agent switched on in
 * Copilot settings).
 */
import { env } from '../config/env.js';
import { EXTERNAL_FETCH_TIMEOUT_MS } from '../config/constants.js';
import { ConfigurationError, IntegrationError } from '../types/errors.js';

export type BuildAgent = 'copilot' | 'claude';
export const BUILD_AGENTS: readonly BuildAgent[] = ['copilot', 'claude'];

const API = 'https://api.github.com';
const GRAPHQL_FEATURES = 'issues_copilot_assignment_api_support,coding_agent_model_selection';
const MAX_ERROR_DETAIL_CHARS = 300;
const ACTORS_CACHE_MS = 10 * 60_000; // eslint-disable-line @typescript-eslint/no-magic-numbers
/** Branch already deleted (404) or not deletable as a ref (422) — both fine after a merge. */
const BRANCH_GONE_STATUSES = [404, 422]; // eslint-disable-line @typescript-eslint/no-magic-numbers

/** Logins (lower-case) we accept for each agent in suggestedActors. */
const AGENT_LOGINS: Record<BuildAgent, readonly string[]> = {
  copilot: ['copilot-swe-agent', 'copilot'],
  claude: ['claude', 'anthropic-code-agent', 'claude-code', 'claude-swe-agent'],
};

/** How an agent is addressed in a PR comment to ask for a fix. */
export const AGENT_MENTION: Record<BuildAgent, string> = { copilot: '@copilot', claude: '@claude' };

export interface AgentPullRequest {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  /** GitHub's mergeable_state: clean | unstable | dirty | blocked | behind | unknown | draft | has_hooks. */
  mergeableState: string;
  headRef: string;
  headSha: string;
  htmlUrl: string;
  changedFiles: string[];
}

export interface CheckSummary {
  total: number;
  pending: number;
  failed: number;
  failedNames: string[];
}

export interface CreatedIssue { number: number; url: string }

/** Whether the agent is still working on its PR, read from the PR timeline. */
export interface AgentActivity { working: boolean; lastFinishedAt: string | null }

export interface AgentIssueInput {
  repo: string; title: string; body: string; agent: BuildAgent; baseRef: string; model?: string; customInstructions?: string;
}

/** Everything the runner needs from GitHub — mocked in tests. */
export interface AgentGitHub {
  createAgentIssue(input: AgentIssueInput): Promise<CreatedIssue>;
  findPullRequestForIssue(repo: string, issueNumber: number): Promise<AgentPullRequest | null>;
  getPullRequest(repo: string, prNumber: number): Promise<AgentPullRequest>;
  getAgentActivity(repo: string, prNumber: number): Promise<AgentActivity>;
  getChecks(repo: string, sha: string): Promise<CheckSummary>;
  markReadyForReview(repo: string, prNumber: number): Promise<void>;
  mergePullRequest(repo: string, prNumber: number, title: string): Promise<void>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  comment(repo: string, issueOrPrNumber: number, body: string): Promise<void>;
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  listAvailableAgents(repo: string): Promise<BuildAgent[]>;
  listBranches(repo: string): Promise<RepoBranches>;
}

/** Branches of a repo, default branch first. */
export interface RepoBranches { defaultBranch: string; branches: string[] }

const BRANCH_PAGE_SIZE = 100;

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (owner === undefined || name === undefined || owner === '' || name === '') {
    throw new IntegrationError('github', `Invalid repo "${repo}" — expected owner/name`);
  }
  return { owner, name };
}

interface RawPull {
  number: number; state: 'open' | 'closed'; merged?: boolean; merged_at?: string | null; draft?: boolean;
  mergeable_state?: string; head: { ref: string; sha: string }; html_url: string; node_id: string;
}

interface Actor { id: string; login: string }

export class GitHubAgentClient implements AgentGitHub {
  private readonly token: string;
  private readonly actorCache = new Map<string, { repoId: string; actors: Actor[]; at: number }>();

  public constructor(token = env.GITHUB_AGENT_TOKEN ?? env.GITHUB_ACCESS_TOKEN) {
    if (token === undefined || token === '') throw new ConfigurationError('GITHUB_AGENT_TOKEN');
    this.token = token;
  }

  private async rest<T>(method: string, path: string, body?: unknown, tolerate: readonly number[] = []): Promise<T | null> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });
    if (tolerate.includes(response.status)) return null;
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new IntegrationError('github', `${method} ${path} failed: ${response.status} ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`);
    }
    const text = await response.text();
    return (text === '' ? null : JSON.parse(text)) as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'GraphQL-Features': GRAPHQL_FEATURES,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new IntegrationError('github', `GraphQL failed: ${response.status}`);
    const json = await response.json() as { data?: T; errors?: { message: string }[] };
    if (json.errors !== undefined && json.errors.length > 0) {
      throw new IntegrationError('github', `GraphQL: ${json.errors.map((e) => e.message).join('; ').slice(0, MAX_ERROR_DETAIL_CHARS)}`);
    }
    if (json.data === undefined) throw new IntegrationError('github', 'GraphQL returned no data');
    return json.data;
  }

  private async repoActors(repo: string): Promise<{ repoId: string; actors: Actor[] }> {
    const cached = this.actorCache.get(repo);
    if (cached !== undefined && Date.now() - cached.at < ACTORS_CACHE_MS) return cached;
    const { owner, name } = splitRepo(repo);
    const data = await this.graphql<{
      repository: { id: string; suggestedActors: { nodes: { id?: string; login?: string }[] } } | null;
    }>(
      `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id
        suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){nodes{login ... on Bot{id} ... on User{id}}}}}`,
      { owner, name },
    );
    if (data.repository === null) throw new IntegrationError('github', `Repository ${repo} not found or not accessible`);
    const result = {
      repoId: data.repository.id,
      actors: data.repository.suggestedActors.nodes
        .filter((n): n is Actor => typeof n.id === 'string' && typeof n.login === 'string'),
      at: Date.now(),
    };
    this.actorCache.set(repo, result);
    return result;
  }

  private static matchAgent(actors: Actor[], agent: BuildAgent): Actor | undefined {
    const wanted = AGENT_LOGINS[agent];
    return actors.find((a) => wanted.includes(a.login.toLowerCase()))
      ?? actors.find((a) => a.login.toLowerCase().includes(agent));
  }

  public async listAvailableAgents(repo: string): Promise<BuildAgent[]> {
    const { actors } = await this.repoActors(repo);
    return BUILD_AGENTS.filter((a) => GitHubAgentClient.matchAgent(actors, a) !== undefined);
  }

  public async listBranches(repo: string): Promise<RepoBranches> {
    const { owner, name } = splitRepo(repo);
    const path = `/repos/${owner}/${name}`;
    const [info, branches] = await Promise.all([
      this.rest<{ default_branch: string }>('GET', path),
      this.rest<{ name: string }[]>('GET', `${path}/branches?per_page=${BRANCH_PAGE_SIZE.toString()}`),
    ]);
    const defaultBranch = info?.default_branch ?? 'main';
    const names = (branches ?? []).map((b) => b.name).filter((b) => b !== defaultBranch).sort((a, b) => a.localeCompare(b));
    return { defaultBranch, branches: [defaultBranch, ...names] };
  }

  public async createAgentIssue(input: AgentIssueInput): Promise<CreatedIssue> {
    const { repoId, actors } = await this.repoActors(input.repo);
    const actor = GitHubAgentClient.matchAgent(actors, input.agent);
    if (actor === undefined) {
      throw new IntegrationError('github',
        `The ${input.agent} agent isn't assignable in ${input.repo}. Enable it for this repo in GitHub Copilot settings.`);
    }
    const agentAssignment: Record<string, unknown> = { targetRepositoryId: repoId, baseRef: input.baseRef };
    if (input.customInstructions !== undefined && input.customInstructions !== '') agentAssignment['customInstructions'] = input.customInstructions;
    if (input.model !== undefined && input.model !== '') agentAssignment['model'] = input.model;
    const data = await this.graphql<{ createIssue: { issue: { number: number; url: string } } }>(
      'mutation($input:CreateIssueInput!){createIssue(input:$input){issue{number url}}}',
      { input: { repositoryId: repoId, title: input.title, body: input.body, assigneeIds: [actor.id], agentAssignment } },
    );
    return data.createIssue.issue;
  }

  private async toPull(repo: string, raw: RawPull): Promise<AgentPullRequest> {
    const files = await this.rest<{ filename: string }[]>('GET', `/repos/${repo}/pulls/${raw.number}/files?per_page=100`) ?? [];
    return {
      number: raw.number,
      state: raw.state,
      merged: raw.merged === true || (raw.merged_at !== undefined && raw.merged_at !== null),
      draft: raw.draft === true,
      mergeableState: raw.mergeable_state ?? 'unknown',
      headRef: raw.head.ref,
      headSha: raw.head.sha,
      htmlUrl: raw.html_url,
      changedFiles: files.map((f) => f.filename),
    };
  }

  public async getPullRequest(repo: string, prNumber: number): Promise<AgentPullRequest> {
    const raw = await this.rest<RawPull>('GET', `/repos/${repo}/pulls/${prNumber}`);
    if (raw === null) throw new IntegrationError('github', `PR #${prNumber} not found in ${repo}`);
    return this.toPull(repo, raw);
  }

  /** The agent links its PR to the issue; read the issue timeline for a cross-referenced PR in the same repo. */
  public async findPullRequestForIssue(repo: string, issueNumber: number): Promise<AgentPullRequest | null> {
    const events = await this.rest<{
      event: string; source?: { issue?: { number: number; pull_request?: unknown; repository?: { full_name: string } } };
    }[]>('GET', `/repos/${repo}/issues/${issueNumber}/timeline?per_page=100`) ?? [];
    const candidates = events
      .filter((e) => e.event === 'cross-referenced' && e.source?.issue?.pull_request !== undefined)
      .filter((e) => (e.source?.issue?.repository?.full_name ?? repo).toLowerCase() === repo.toLowerCase())
      .map((e) => e.source?.issue?.number)
      .filter((n): n is number => typeof n === 'number');
    const latest = candidates.at(-1);
    return latest === undefined ? null : this.getPullRequest(repo, latest);
  }

  /**
   * Agents post "work started" / "work finished" events on their PR timeline
   * (Copilot: copilot_work_started / copilot_work_finished). Working = the latest
   * start has no later finish. Agents without these events report not working,
   * and the runner falls back to the PR's draft flag.
   */
  public async getAgentActivity(repo: string, prNumber: number): Promise<AgentActivity> {
    const events = await this.rest<{ event?: string; created_at?: string }[]>(
      'GET', `/repos/${repo}/issues/${prNumber}/timeline?per_page=100`,
    ) ?? [];
    let started = -1;
    let finished = -1;
    let lastFinishedAt: string | null = null;
    events.forEach((e, i) => {
      const name = (e.event ?? '').toLowerCase();
      if (/work_started$/.test(name)) started = i;
      if (/work_finished$|work_stopped$/.test(name)) { finished = i; lastFinishedAt = e.created_at ?? null; }
    });
    return { working: started > finished, lastFinishedAt };
  }

  public async getChecks(repo: string, sha: string): Promise<CheckSummary> {
    const data = await this.rest<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(
      'GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    );
    const runs = data?.check_runs ?? [];
    const ok = new Set(['success', 'neutral', 'skipped']);
    const failed = runs.filter((r) => r.status === 'completed' && !ok.has(r.conclusion ?? ''));
    return {
      total: runs.length,
      pending: runs.filter((r) => r.status !== 'completed').length,
      failed: failed.length,
      failedNames: failed.map((r) => r.name),
    };
  }

  public async markReadyForReview(repo: string, prNumber: number): Promise<void> {
    const raw = await this.rest<RawPull>('GET', `/repos/${repo}/pulls/${prNumber}`);
    if (raw?.draft !== true) return;
    await this.graphql('mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}', { id: raw.node_id });
  }

  public async mergePullRequest(repo: string, prNumber: number, title: string): Promise<void> {
    await this.rest('PUT', `/repos/${repo}/pulls/${prNumber}/merge`, { merge_method: 'squash', commit_title: `${title} (#${prNumber})` });
  }

  public async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.rest('DELETE', `/repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, undefined, BRANCH_GONE_STATUSES);
  }

  public async comment(repo: string, issueOrPrNumber: number, body: string): Promise<void> {
    await this.rest('POST', `/repos/${repo}/issues/${issueOrPrNumber}/comments`, { body });
  }

  public async closeIssue(repo: string, issueNumber: number): Promise<void> {
    await this.rest('PATCH', `/repos/${repo}/issues/${issueNumber}`, { state: 'closed', state_reason: 'not_planned' });
  }
}

let shared: AgentGitHub | null = null;
/** Lazily-built shared client (throws ConfigurationError when no token is set). */
export function getAgentGitHub(): AgentGitHub {
  shared ??= new GitHubAgentClient();
  return shared;
}
/** Test seam. */
export function setAgentGitHub(client: AgentGitHub | null): void { shared = client; }
