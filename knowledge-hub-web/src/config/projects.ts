/**
 * Project definitions — local config.
 *
 * Each project groups related content from one or more sources.
 * `gitlabPaths` and `githubRepos` are used to auto-match timeline items.
 * `links` stores external URLs (Claude AI project, website, etc.).
 *
 * To add a new project: copy an existing entry, give it a unique `id`,
 * update the paths/repos, and add it to the PROJECTS array.
 */

export interface ProjectLink {
  label: string;
  url: string;
}

export interface Project {
  id: string;
  name: string;
  /** Carbon tag colour for this project */
  colour: 'blue' | 'cyan' | 'teal' | 'purple' | 'green' | 'magenta' | 'warm-gray' | 'gray' | 'red';
  description?: string;
  /** GitLab project paths that belong to this project, e.g. "structara-group/Structara-AI" */
  gitlabPaths?: string[];
  /** GitHub repos that belong to this project, e.g. "richardichogan/BlogSite" */
  githubRepos?: string[];
  /** External links — Claude AI project, website, etc. */
  links?: ProjectLink[];
  tags?: string[];
}

export const PROJECTS: Project[] = [
  // ── Structara AI ────────────────────────────────────────────────────────────
  {
    id: 'structara-ai',
    name: 'Structara AI',
    colour: 'purple',
    description: 'AI-powered architecture diagramming tool',
    gitlabPaths: ['structara-group/Structara-AI'],
    links: [],
    tags: ['ai', 'architecture', 'saas'],
  },

  // ── IBM ──────────────────────────────────────────────────────────────────────
  {
    id: 'ibm-thought-leadership',
    name: 'IBM Thought Leadership',
    colour: 'blue',
    description: 'IBM thought leadership content, speaking and hackathons',
    githubRepos: [
      'IBM-Hackaton-2025/team_103_nogap',
    ],
    links: [],
    tags: ['ibm', 'content'],
  },
  {
    id: 'ibm-msft-practice',
    name: 'IBM / MSFT Practice',
    colour: 'blue',
    description: 'IBM and Microsoft partnership practice work',
    links: [],
    tags: ['ibm', 'microsoft', 'practice'],
  },

  // ── IMAGINE ──────────────────────────────────────────────────────────────────
  {
    id: 'imagine',
    name: 'IMAGINE',
    colour: 'gray',
    description: 'IBM Project IMAGINE MVP demo',
    githubRepos: ['IBM-Project-Imagine/mvp-demo'],
    links: [],
    tags: [],
  },

  // ── Microsoft Cloud Blog ─────────────────────────────────────────────────────
  {
    id: 'microsoft-cloud-blog',
    name: 'Microsoft Cloud Blog',
    colour: 'teal',
    description: 'The Microsoft Cloud Blog — themicrosoftcloudblog.com',
    githubRepos: ['richardichogan/themicrosoftcloudblog'],
    links: [],
    tags: ['content', 'blog', 'microsoft'],
  },

  // ── Personal Blog / Content ──────────────────────────────────────────────────
  {
    id: 'blog-site',
    name: 'Blog Site',
    colour: 'cyan',
    description: 'Personal blog site',
    githubRepos: ['richardichogan/BlogSite'],
    links: [],
    tags: ['content', 'blog'],
  },
  {
    id: 'neli-blog',
    name: 'Neli Blog',
    colour: 'cyan',
    description: "Neli Hogan's blog site",
    githubRepos: ['richardichogan/neli-blog'],
    links: [],
    tags: ['content', 'blog'],
  },
  {
    id: 'techbytes',
    name: 'TechBytes',
    colour: 'cyan',
    description: 'TechBytes content site',
    githubRepos: ['richardichogan/TechBytes'],
    links: [],
    tags: ['content'],
  },

  // ── Client / Partner Projects ────────────────────────────────────────────────
  {
    id: 'acre',
    name: 'ATOM',
    colour: 'green',
    description: 'ATOM project (formerly ACRE)',
    githubRepos: ['richardichogan/ACRE'],
    links: [],
    tags: [],
  },
  {
    id: 'ifa-project',
    name: 'NELFIN',
    colour: 'green',
    description: 'NELFIN project (formerly IFA Project)',
    githubRepos: ['richardichogan/ifa-project'],
    links: [],
    tags: [],
  },
  {
    id: 'msft-partner-dashboard',
    name: 'MSFT Partner Dashboard',
    colour: 'blue',
    description: 'Microsoft partner dashboard',
    githubRepos: ['richardichogan/msft-partner-dashboard'],
    links: [],
    tags: ['microsoft'],
  },

  // ── GitLab personal ──────────────────────────────────────────────────────────
  {
    id: 'content-pipeline',
    name: 'Content Pipeline',
    colour: 'magenta',
    description: 'Content pipeline automation',
    gitlabPaths: ['richardhogan/content-pipeline'],
    links: [],
    tags: ['automation', 'content'],
  },
  {
    id: 'healthwise',
    name: 'Healthwise',
    colour: 'green',
    description: 'Healthwise project',
    gitlabPaths: ['richardhogan/Healthwise'],
    links: [],
    tags: [],
  },

  // ── Personal / Other ─────────────────────────────────────────────────────────
  {
    id: 'github-misc',
    name: 'GitHub Misc',
    colour: 'gray',
    description: 'Miscellaneous GitHub repos',
    githubRepos: ['richardichogan/github-slideshow'],
    links: [],
    tags: [],
  },
  {
    id: 'personal',
    name: 'Personal',
    colour: 'gray',
    description: 'Personal notes, tasks and general activity',
    links: [],
    tags: [],
  },
];

/** Quickly look up a project by id */
export const PROJECT_MAP = new Map<string, Project>(PROJECTS.map((p) => [p.id, p]));

/**
 * Given a timeline item's source + metadata, return the matching project id.
 * Falls back to the item's own projectContext, then 'personal'.
 */
export function inferProjectId(
  source: string,
  metadata: Record<string, unknown> | undefined,
  projectContext: string | undefined,
): string {
  if (metadata != null) {
    const path = typeof metadata['projectPath'] === 'string' ? metadata['projectPath'] : null;
    const repo = typeof metadata['repo'] === 'string' ? metadata['repo']
      : typeof metadata['repoFullName'] === 'string' ? metadata['repoFullName'] : null;

    for (const project of PROJECTS) {
      if (path !== null && project.gitlabPaths?.includes(path)) return project.id;
      if (repo !== null && project.githubRepos?.includes(repo)) return project.id;
    }
  }

  if (projectContext != null) {
    // Direct match on id
    if (PROJECT_MAP.has(projectContext)) return projectContext;
  }

  return 'personal';
}
