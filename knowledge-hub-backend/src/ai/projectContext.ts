import type { Pool } from 'pg';
import type { ProjectType } from '../services/projectTypes.js';
import { PROJECT_RELATION_COLUMNS, rowToRelations, type ProjectRelations } from '../services/projectRelations.js';

export interface CurrentProjectContext extends ProjectRelations {
  id: string;
  name: string;
  description: string;
  goal: string;
  role: string;
  ownership: string;
  lifecycleState: string;
  startDate: string | null;
  targetEndDate: string | null;
  importance: string;
  priority: string;
  category: string;
  projectType: ProjectType;
  expectedOutputs: string[];
  links: Array<{ label: string; url: string }>;
  gitlabPaths: string[];
  githubRepos: string[];
  tags: string[];
  hasIcaDocumentCollection: boolean;
  icaDocumentCollectionName: string;
  icaDocumentCollectionId: string;
}

/** Query on every turn/lookup; project edits must not depend on a chat restart. */
export async function loadCurrentProjectContext(db: Pool, projectId: string): Promise<CurrentProjectContext | null> {
  const { rows } = await db.query<CurrentProjectContext & Record<string, unknown>>(
    `SELECT id, name, description, goal, role, ownership,
      lifecycle_state AS "lifecycleState",
      to_char(start_date, 'YYYY-MM-DD') AS "startDate",
      to_char(target_end_date, 'YYYY-MM-DD') AS "targetEndDate",
      importance, priority, category, project_type AS "projectType",
      expected_outputs AS "expectedOutputs", links,
      gitlab_paths AS "gitlabPaths", github_repos AS "githubRepos", tags,
      has_ica_document_collection AS "hasIcaDocumentCollection",
      ica_document_collection_name AS "icaDocumentCollectionName",
      ica_document_collection_id AS "icaDocumentCollectionId",
      ${PROJECT_RELATION_COLUMNS}
    FROM projects WHERE id = $1`,
    [projectId],
  );
  const project = rows[0];
  if (!project) return null;
  const fields = { ...project };
  delete fields['client_company'];
  delete fields['partner_companies'];
  delete fields['offering_link'];
  delete fields['linked_projects'];
  return {
    ...fields,
    ...rowToRelations(project),
    links: Array.isArray(project.links) ? project.links : [],
    expectedOutputs: Array.isArray(project.expectedOutputs) ? project.expectedOutputs : [],
    gitlabPaths: Array.isArray(project.gitlabPaths) ? project.gitlabPaths : [],
    githubRepos: Array.isArray(project.githubRepos) ? project.githubRepos : [],
    tags: Array.isArray(project.tags) ? project.tags : [],
  };
}

export function formatCurrentProjectContext(project: CurrentProjectContext): string {
  return [
    'Current saved workstream information (refreshed this turn; takes precedence over older chat history, memories and workstream notes):',
    `Workstream: ${project.name} (id: ${project.id})`,
    project.description && `Description: ${project.description}`,
    project.goal && `Goal: ${project.goal}`,
    project.role && `User's role: ${project.role}`,
    project.ownership && `Ownership: ${project.ownership}`,
    `State: ${project.lifecycleState}; importance: ${project.importance}; priority: ${project.priority}`,
    `Category: ${project.category}; type: ${project.projectType}`,
    project.startDate && `Start date: ${project.startDate}`,
    project.targetEndDate && `Target end date: ${project.targetEndDate}`,
    project.expectedOutputs.length > 0 && `Deliverables:\n${project.expectedOutputs.map((output) => `- ${output}`).join('\n')}`,
    project.client && `Client: ${project.client.name}`,
    project.partners.length > 0 && `Partners: ${project.partners.map((partner) => partner.name).join(', ')}`,
    project.offeringLink && `Offering: ${project.offeringLink.relation === 'sells' ? 'sells' : 'related to'} ${project.offeringLink.offeringName} (id: ${project.offeringLink.offeringId})`,
    project.linkedProjects.length > 0 && `Projects and opportunities linked to this offering:\n${project.linkedProjects.map((linked) => `- ${linked.name} (id: ${linked.id}; ${linked.projectType}; ${linked.relation === 'sells' ? 'sells it' : 'related'})`).join('\n')}`,
    'Work type describes the nature of the work. A project is delivery work; an opportunity is a sales pursuit for a client; an offering is something sold (projects and opportunities can sell or relate to it). BAU is an ongoing responsibility; an aspiration is a direction for growth. Neither implies a required end date or completion score.',
    project.githubRepos.length > 0 && `GitHub repositories: ${project.githubRepos.join(', ')}`,
    project.gitlabPaths.length > 0 && `GitLab paths: ${project.gitlabPaths.join(', ')}`,
    project.tags.length > 0 && `Tags: ${project.tags.join(', ')}`,
    project.hasIcaDocumentCollection && `ICA document collection: ${project.icaDocumentCollectionName} (id: ${project.icaDocumentCollectionId})`,
  ].filter(Boolean).join('\n');
}
