/**
 * ai/assetTools.ts — Athena's tools for creating and changing app assets beyond notes, tasks and Sparks:
 * Discover sources and article states, Sparks, projects, Think notes by id, diagrams and mind maps.
 *
 * Each tool writes through the same services/SQL as the corresponding UI route, so Athena's changes
 * look exactly like the user's own. Nothing here deletes data: removal is limited to disabling a
 * feed, shelving/archiving an article, archiving a project, or removing shapes from a diagram
 * (which keeps its revision history).
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { textToBlocks } from './markdownToNoteBlocks.js';
import {
  AI_AGENT_MODES, AI_ASSERTION_LEVELS, AI_FLOW_EDGE_TYPES, AI_FLOW_INTERACTIONS, AI_FLOW_STATES, AI_FLOW_STEP_TYPES, AI_FLOW_VOLUMES,
  AI_GATE_ACCEPTANCE_FAILURES, AI_GATE_DELEGATION_FAILURES, AI_GATE_EVALUATIONS, AI_GATE_KINDS, AI_GATE_OUTCOMES, AI_MEMORY_SCOPES, DATA_SENSITIVITIES,
  type AiFlowAgent, type AiFlowControls, type AiFlowEdge, type AiFlowGate, type AiFlowGateAcceptance, type AiFlowGateDelegation, type AiFlowGateShared,
  type AiFlowOperations, type AiFlowStep,
  type DiagramDocument, type DiagramEdge, type DiagramNode, type DiagramKind,
} from '../types/diagram.js';
import { checkAiFlow, EDGE_STYLES, layoutAiFlow, nextLaneOrder, rankFlowNodes, STEP_STYLES } from '../services/aiFlow.js';
import { layoutGeneralDiagram } from '../services/diagramLayout.js';
import { DIAGRAM_LIMITS, currentStepType } from '../services/diagramValidation.js';
import { env } from '../config/env.js';

export const ASSET_WRITE_TOOLS = [
  'add_discover_source', 'update_discover_source', 'set_discover_item_state', 'update_spark',
  'create_project', 'update_project', 'update_note', 'create_diagram', 'update_diagram', 'create_mind_map',
  'create_weekly_microsoft_digest',
] as const;
type AssetToolName = typeof ASSET_WRITE_TOOLS[number];

export function isAssetTool(name: string): name is AssetToolName {
  return (ASSET_WRITE_TOOLS as readonly string[]).includes(name);
}

const DISCOVER_STATES = ['to-review', 'saved', 'blog', 'archived', 'published', 'shelved'] as const;
const PROJECT_CATEGORIES = ['work', 'personal', 'side-hustle'] as const;
const PROJECT_PRIORITIES = ['low', 'medium', 'high'] as const;
const PROJECT_IMPORTANCE = ['critical', 'high', 'normal', 'low'] as const;
const PROJECT_LIFECYCLE = ['active', 'paused', 'completed', 'archived'] as const;
const NODE_KINDS = ['process', 'decision', 'hexagon', 'terminator', 'document'] as const;
const MAX_DIAGRAM_NODES = 80;
const MAX_MAP_IDEAS = 60;
const MAX_PROJECT_ID_CHARS = 60;
const PERCENTAGE_MAX = 100;
const MAX_LANE_DESCRIPTION_CHARS = 2_000;
const MAX_GOVERNANCE_FINDINGS = 10;

/** Diagram colour names → saved (light-theme) fill and border, as the editor's swatches use. */
export const DIAGRAM_COLOURS: Record<string, { fill: string; stroke: string }> = {
  grey: { fill: '#ffffff', stroke: '#161616' },
  blue: { fill: '#edf5ff', stroke: '#0f62fe' },
  green: { fill: '#defbe6', stroke: '#198038' },
  yellow: { fill: '#fcf4d6', stroke: '#b28600' },
  red: { fill: '#fff1f1', stroke: '#da1e28' },
  purple: { fill: '#f6f2ff', stroke: '#8a3ffc' },
};
const COLOUR_NAMES = Object.keys(DIAGRAM_COLOURS);
const NODE_SIZE: Record<typeof NODE_KINDS[number], { width: number; height: number }> = {
  process: { width: 160, height: 64 },
  decision: { width: 140, height: 90 },
  hexagon: { width: 160, height: 80 },
  terminator: { width: 160, height: 52 },
  document: { width: 160, height: 80 },
};
const LAYOUT = { left: 80, top: 80, gap: 80 };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : undefined;

const textList = (description: string): { type: string; items: { type: string }; description: string } =>
  ({ type: 'array', items: { type: 'string' }, description });
/** AI flow step metadata accepted on shapes; only record what the user stated or the sources show. */
const aiFlowStepProperties = {
  lane: { type: 'string', description: 'AI flow: key, label or id of the lane this step sits in.' },
  stepType: {
    type: 'string', enum: [...AI_FLOW_STEP_TYPES],
    description: 'AI flow: channel_interaction (customer touchpoint), human_task, digital_steward (orchestrates and oversees digital workers and specialist agents), digital_worker (AI agent that carries out process tasks), specialist_agent (AI agent with deep domain expertise called on for specific tasks), decision_gate (governance control point between agents, e.g. Digital Steward and Digital Worker: may work begin, may returned work be used, or escalate to a human), decision_rules (deterministic rules), integration (system/API call), data_operation (read/write a store), external_party. Sets the default shape and colour.',
  },
  state: { type: 'string', enum: [...AI_FLOW_STATES], description: 'AI flow: part of the existing process, the future (target) process, or both.' },
  actor: { type: 'string', description: 'AI flow: who or what performs the step.' },
  systems: textList('AI flow: systems involved.'),
  dataIn: textList('AI flow: data the step consumes.'),
  dataOut: textList('AI flow: data the step produces.'),
  agent: {
    type: 'object',
    description: 'AI flow: for digital_steward, digital_worker and specialist_agent steps.',
    properties: {
      role: { type: 'string' },
      mode: { type: 'string', enum: [...AI_AGENT_MODES], description: 'Autonomy: assistive (A1, human decides) to autonomous (A4, acts alone).' },
      assertion: { type: 'string', enum: [...AI_ASSERTION_LEVELS], description: 'How binding its output is: signal, advisory or authoritative.' },
      orchestrator: { type: 'string', description: 'The orchestrating agent, if any.' },
      tools: textList('Tools/APIs the agent can call.'),
      knowledge: textList('Knowledge sources it is grounded on.'),
      guardrails: textList('Guardrails constraining it.'),
      escalationPath: { type: 'string', description: 'Where it escalates when unsure or out of bounds.' },
      decisionBoundary: { type: 'string', description: 'What it may and may not decide.' },
      confidenceThreshold: { type: 'number', description: '0–1 confidence below which it escalates.' },
      memory: { type: 'string', enum: [...AI_MEMORY_SCOPES] },
      model: { type: 'string' },
      promptVersion: { type: 'string' },
    },
  },
  controls: {
    type: 'object',
    description: 'AI flow: governance controls on the step.',
    properties: {
      sensitivity: { type: 'string', enum: [...DATA_SENSITIVITIES], description: 'Most sensitive data the step handles.' },
      authRequired: { type: 'boolean' }, authModel: { type: 'string' },
      auditLogging: { type: 'boolean' }, humanApproval: { type: 'boolean' },
      regulatoryTags: textList('e.g. GDPR, FCA Consumer Duty, EU AI Act.'),
    },
  },
  operations: {
    type: 'object',
    description: 'AI flow: operational characteristics.',
    properties: {
      volume: { type: 'string', enum: [...AI_FLOW_VOLUMES] }, sla: { type: 'string' },
      failureHandling: { type: 'string' }, monitoring: { type: 'string' },
    },
  },
  gate: {
    type: 'object',
    description: 'AI flow: decision_gate steps only. The control rules the gate applies; record only what the user stated or the sources show. Route escalation through a connector with gateOutcome "escalate" to a human_task.',
    properties: {
      gateKind: { type: 'string', enum: [...AI_GATE_KINDS], description: 'delegation_acceptance (Steward ? Worker: may work begin, may returned work be used), acceptance (consolidation check on returned work), action_authorisation (before settlement, adverse decisions or customer communication). Defaults to delegation_acceptance.' },
      delegation: {
        type: 'object', description: 'Delegation (Steward ? Worker): may work begin?',
        properties: {
          permittedWork: { type: 'string' }, authorityLimits: { type: 'string' },
          requiredInputs: textList('Inputs that must be present before work begins.'), obligations: textList('Obligations the worker must meet.'),
          approvalConditions: { type: 'string' }, evidence: textList('Evidence recorded for the delegation decision.'),
          onFail: { type: 'string', enum: [...AI_GATE_DELEGATION_FAILURES] },
        },
      },
      acceptance: {
        type: 'object', description: 'Acceptance (Worker ? Steward): may the returned work be used? Returned work is not approved work.',
        properties: {
          requiredOutputs: textList('Outputs the worker must return.'), validationCriteria: { type: 'string' },
          uncertaintyHandling: { type: 'string', description: 'Low confidence, conflicting evidence and exceptions.' },
          humanReviewConditions: { type: 'string' }, evidence: textList('Evidence recorded for the acceptance decision.'),
          onFail: { type: 'string', enum: [...AI_GATE_ACCEPTANCE_FAILURES] },
        },
      },
      shared: {
        type: 'object', description: 'Governance shared by both directions.',
        properties: {
          accountableOwner: { type: 'string' }, controlRefs: textList('Policy or control ids with versions.'),
          enforcedBy: { type: 'string', description: 'Component that enforces the gate.' }, overrideAuthority: { type: 'string' },
          pendingBehaviour: { type: 'string', description: 'What happens while a decision is pending.' },
          recordRequirements: textList('What the decision record must retain.'),
        },
      },
    },
  },
};
const aiFlowEdgeProperties = {
  edgeType: {
    type: 'string', enum: [...AI_FLOW_EDGE_TYPES],
    description: 'AI flow: primary_flow (main path), supporting_flow, conditional_flow (only when a condition holds), dependency, control (a governance check acting on a step). Defaults to primary_flow.',
  },
  interaction: { type: 'string', enum: [...AI_FLOW_INTERACTIONS], description: 'AI flow: sync, async, agent_handoff or human_handoff.' },
  payload: { type: 'string', description: 'AI flow: what is passed along.' },
  sensitivity: { type: 'string', enum: [...DATA_SENSITIVITIES] },
  auth: { type: 'string', description: 'AI flow: how the hop is authenticated.' },
  condition: { type: 'string', description: 'AI flow: when a conditional flow is taken.' },
  gateEvaluation: { type: 'string', enum: [...AI_GATE_EVALUATIONS], description: 'AI flow: on a connector to or from a decision_gate, which evaluation it carries.' },
  gateOutcome: { type: 'string', enum: [...AI_GATE_OUTCOMES], description: 'AI flow: on a connector from a decision_gate, the outcome it represents. Escalate goes to a named human_task.' },
};
const diagramNodeSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Short handle used by connectors in this call (defaults to the label).' },
    label: { type: 'string' },
    description: { type: 'string', description: 'Longer explanation; shown when a footnote marker is added.' },
    kind: { type: 'string', enum: [...NODE_KINDS] },
    colour: { type: 'string', enum: COLOUR_NAMES, description: 'Border/fill colour. Use colours consistently by meaning and name them in the legend. In an AI flow, leave it out so the step type sets the colour.' },
    footnote: { type: 'boolean', description: 'Add a numbered footnote marker showing the description.' },
    ...aiFlowStepProperties,
  },
  required: ['label'],
};
const diagramEdgeSchema = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'Key, label or id of the source shape.' },
    to: { type: 'string', description: 'Key, label or id of the target shape.' },
    label: { type: 'string' },
    dashed: { type: 'boolean' },
    ...aiFlowEdgeProperties,
  },
  required: ['from', 'to'],
};
const laneSchema = {
  type: 'array',
  description: 'AI flow lanes, top to bottom: one per team, persona, channel, agent group or system that performs steps.',
  items: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short handle steps use in "lane" (defaults to the label).' },
      label: { type: 'string' },
      owner: { type: 'string', description: 'Owning team or persona, shown in the lane header.' },
      description: { type: 'string' },
    },
    required: ['label'],
  },
};
const legendSchema = {
  type: 'array',
  description: 'Key explaining what each colour means.',
  items: { type: 'object', properties: { colour: { type: 'string', enum: COLOUR_NAMES }, label: { type: 'string' } }, required: ['colour', 'label'] },
};

export function getAssetToolDefinitions(): LlmToolDefinition[] {
  const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): LlmToolDefinition => ({
    type: 'function', function: { name, description, parameters: { type: 'object', properties, required } },
  });
  return [
    fn('add_discover_source',
      'Subscribes Discover to an RSS/Atom feed. The feed is read first, so a bad address fails here; only report it as added when this returns success. Check get_discover_sources first to avoid duplicates.',
      {
        title: { type: 'string', description: 'Display name, e.g. "Azure Updates".' },
        feedUrl: { type: 'string', description: 'The feed URL (not an article or home page URL).' },
        groupName: { type: 'string', description: 'Vendor group, e.g. Microsoft, GitHub, Google, AWS, OpenAI, IBM, Other.' },
      }, ['title', 'feedUrl']),
    fn('update_discover_source',
      'Renames, regroups, disables or re-enables an existing Discover feed (from get_discover_sources). Disabling keeps its articles.',
      {
        sourceId: { type: 'string', description: 'Source id, or its exact title.' },
        title: { type: 'string' }, groupName: { type: 'string' },
        active: { type: 'boolean', description: 'false disables the feed, true re-enables it.' },
      }, ['sourceId']),
    fn('set_discover_item_state',
      'Moves a Discover article between To Review, Saved, Blog, Shelved, Archived and Published (e.g. restore a shelved article).',
      {
        itemId: { type: 'string', description: 'Discover item id, or the article URL.' },
        state: { type: 'string', enum: [...DISCOVER_STATES] },
      }, ['itemId', 'state']),
    fn('update_spark', 'Edits an existing Spark\'s text and/or tags.',
      { sparkId: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, ['sparkId']),
    fn('create_project', 'Creates a new project. Only when the user asks for a project; check the project catalogue first so you don\'t duplicate one.',
      {
        name: { type: 'string' }, id: { type: 'string', description: 'Optional short kebab-case id.' },
        description: { type: 'string' }, goal: { type: 'string' },
        category: { type: 'string', enum: [...PROJECT_CATEGORIES] }, priority: { type: 'string', enum: [...PROJECT_PRIORITIES] },
        importance: { type: 'string', enum: [...PROJECT_IMPORTANCE] }, tags: { type: 'array', items: { type: 'string' } },
      }, ['name']),
    fn('update_project', 'Updates a project\'s name, description, goal, category, priority, importance, state (active/paused/completed/archived) or tags. Tags given replace the existing tags.',
      {
        projectId: { type: 'string', description: 'Project id or exact name.' },
        name: { type: 'string' }, description: { type: 'string' }, goal: { type: 'string' },
        category: { type: 'string', enum: [...PROJECT_CATEGORIES] }, priority: { type: 'string', enum: [...PROJECT_PRIORITIES] },
        importance: { type: 'string', enum: [...PROJECT_IMPORTANCE] }, lifecycleState: { type: 'string', enum: [...PROJECT_LIFECYCLE] },
        tags: { type: 'array', items: { type: 'string' } },
      }, ['projectId']),
    fn('update_note',
      'Changes a saved Think note by id, even when it is not open: append content, replace the whole body (a checkpoint of the previous version is kept in its history), rename it, or move it to another project. For the note open beside the chat use propose_note_edit instead.',
      {
        noteId: { type: 'string' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'How to apply content. Defaults to append.' },
        content: { type: 'string', description: 'Markdown: blank lines separate paragraphs; #, ##, ### make headings; - bullets.' },
        title: { type: 'string' },
        projectId: { type: 'string' },
      }, ['noteId']),
    fn('create_diagram',
      'Creates a new diagram (Think → Diagrams) from shapes and connectors, laid out automatically in aligned, evenly spaced columns with centred branches and separate feedback routes. Use for architectures, flows and processes. ' +
      'Plan the main reading path first, give shapes in logical reading order, keep labels concise, put explanations in descriptions/footnotes, and distinguish primary flow from supporting or return paths. Keep related branches together rather than producing a sprawling list of boxes. ' +
      'When asked to match a saved diagram, read it first and preserve its grouping, hierarchy and visual rhythm. Colour shapes by meaning and add a legend for the colours. ' +
      'For an AI flow / governance diagram (an agentic or AI-assisted process mapped to agents, tools and controls) set diagramType "ai-flow", give lanes (one per team, persona, channel, agent group or system, with its owner) and give every step a lane and a stepType; ' +
      'fill agent details on AI steps and controls where data is sensitive. Only record agents, tools and controls the user stated or the sources show — leave unknowns out so the governance findings in the result show the gaps. Lanes and steps are laid out as swimlanes.',
      {
        title: { type: 'string' }, description: { type: 'string' },
        projectId: { type: 'string', description: 'Project to file it under.' },
        diagramType: { type: 'string', enum: ['general', 'ai-flow'], description: 'ai-flow for an AI flow / governance swimlane diagram. Defaults to general, or ai-flow when lanes are given.' },
        lanes: laneSchema,
        nodes: { type: 'array', items: diagramNodeSchema },
        edges: { type: 'array', items: diagramEdgeSchema },
        legend: legendSchema,
      }, ['title', 'nodes']),
    fn('update_diagram',
      'Changes a saved diagram (find it with search_diagrams/read_diagram): add shapes and connectors, relabel/recolour/describe shapes, remove shapes, set the legend or rename it. Earlier versions stay in its history. ' +
      'For AI flow diagrams it can also add lanes, move steps between lanes, set step, agent, control and connector metadata, and re-run the swimlane layout (it re-runs automatically when lanes or steps are added or moved).',
      {
        diagramId: { type: 'string' }, title: { type: 'string' },
        diagramType: { type: 'string', enum: ['general', 'ai-flow'], description: 'Switch the diagram type.' },
        addLanes: laneSchema,
        addNodes: { type: 'array', items: diagramNodeSchema },
        addEdges: { type: 'array', items: diagramEdgeSchema },
        updateNodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Id or current label.' }, label: { type: 'string' }, description: { type: 'string' },
              colour: { type: 'string', enum: COLOUR_NAMES }, footnote: { type: 'boolean' },
              ...aiFlowStepProperties,
              owner: { type: 'string', description: 'AI flow lanes only: owning team or persona.' },
              order: { type: 'number', description: 'AI flow lanes only: position, lower is higher up.' },
            },
            required: ['node'],
          },
          description: 'AI flow metadata given here is merged into what the shape already has.',
        },
        updateEdges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              edge: { type: 'string', description: 'Connector id. Or give from and to instead.' },
              from: { type: 'string' }, to: { type: 'string' },
              label: { type: 'string' }, dashed: { type: 'boolean' },
              ...aiFlowEdgeProperties,
            },
          },
        },
        removeNodes: { type: 'array', items: { type: 'string' }, description: 'Ids or labels; their connectors go too.' },
        relayout: { type: 'boolean', description: 'Explicitly rearrange the diagram into aligned, evenly spaced columns (or swimlanes for an AI flow). Preserves containers and their children. Leave false for content/style edits to keep the user\'s layout.' },
        legend: legendSchema,
      }, ['diagramId']),
    fn('create_mind_map',
      'Creates a new mind map (Think → Canvases) with a central idea and branches. Each idea can hang off the centre or off an earlier idea.',
      {
        title: { type: 'string' }, projectId: { type: 'string' },
        centre: { type: 'string', description: 'Central idea; defaults to the title.' },
        ideas: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, body: { type: 'string' }, parent: { type: 'string', description: 'Label of an earlier idea; omit for the centre.' } },
            required: ['label'],
          },
        },
      }, ['title', 'ideas']),
    fn('create_weekly_microsoft_digest',
      'Queues the saved Weekly Microsoft updates job using its configured prompt, output destinations and approval policy. ' +
        'Covers the previous full Monday–Sunday. For changing schedules, prompts or approvals use manage_scheduled_jobs. Returns a run link; do not claim publishing completed.',
      {}, []),
  ];
}

export async function executeAssetTool(db: Pool, name: AssetToolName, args: Record<string, unknown>, openNoteId?: string): Promise<unknown> {
  try {
    switch (name) {
      case 'add_discover_source': return await addDiscoverSource(db, args);
      case 'update_discover_source': return await updateDiscoverSource(db, args);
      case 'set_discover_item_state': return await setDiscoverItemState(db, args);
      case 'update_spark': return await updateSpark(db, args);
      case 'create_project': return await createProject(db, args);
      case 'update_project': return await updateProject(db, args);
      case 'update_note': return await updateNote(db, args, openNoteId);
      case 'create_diagram': return await createDiagram(db, args);
      case 'update_diagram': return await updateDiagram(args);
      case 'create_mind_map': return await createMindMap(db, args);
      case 'create_weekly_microsoft_digest': {
        if (env.NODE_ENV !== 'production') return { error: 'Scheduled job execution is disabled on development servers.' };
        const { enqueue, getJob } = await import('../jobs/store.js');
        const job = await getJob(db, 'a7000000-0000-4000-8000-000000000002');
        const run = await enqueue(db, job, new Date(), `manual:${randomUUID()}`, false, 'chat:weekly-digest');
        return { queued: true, runId: run.id, url: `${env.FRONTEND_BASE_URL}/jobs?jobId=${job.id}`, approval: job.definition.approval };
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Discover ─────────────────────────────────────────────────────────────────

async function addDiscoverSource(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const title = str(args['title']);
  const feedUrl = str(args['feedUrl']);
  if (title === undefined || feedUrl === undefined || !/^https?:\/\//i.test(feedUrl)) return { error: 'A title and an http(s) feed URL are needed.' };
  const { readFeed } = await import('../integrations/discovery/feedReader.js');
  let items: number;
  try {
    items = (await readFeed(feedUrl)).length;
  } catch (err) {
    return { error: `Not added — that address didn't work as a feed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { rows } = await db.query<{ id: string; existed: boolean }>(
    `INSERT INTO discovery_sources (title, feed_url, group_name) VALUES ($1, $2, $3)
     ON CONFLICT (feed_url) DO UPDATE SET title = EXCLUDED.title, group_name = EXCLUDED.group_name, is_active = true
     RETURNING id::text, (xmax <> 0) AS existed`,
    [title, feedUrl, str(args['groupName']) ?? 'Other'],
  );
  return {
    success: true, sourceId: rows[0]?.id, title, feedUrl, itemsInFeed: items,
    note: rows[0]?.existed === true ? 'It was already configured; it is now enabled with this name.' : 'Added. Its articles appear in Discover after the next check (about every 30 minutes).',
  };
}

async function updateDiscoverSource(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const ref = str(args['sourceId']);
  if (ref === undefined) return { error: 'sourceId is required.' };
  const active = typeof args['active'] === 'boolean' ? args['active'] : null;
  const { rows } = await db.query<{ id: string; title: string; group_name: string; is_active: boolean }>(
    `UPDATE discovery_sources
        SET is_active = COALESCE($2, is_active), title = COALESCE($3, title), group_name = COALESCE($4, group_name),
            last_error = CASE WHEN $2 = true THEN NULL ELSE last_error END
      WHERE id::text = $1 OR (lower(title) = lower($1) AND NOT EXISTS (SELECT 1 FROM discovery_sources WHERE id::text = $1))
      RETURNING id::text, title, group_name, is_active`,
    [ref, active, str(args['title']) ?? null, str(args['groupName']) ?? null],
  );
  if (rows.length === 0) return { error: 'No Discover source with that id or title. Use get_discover_sources.' };
  if (rows.length > 1) return { error: 'More than one source has that title; use its id.' };
  return { success: true, source: { id: rows[0]!.id, title: rows[0]!.title, group: rows[0]!.group_name, active: rows[0]!.is_active } };
}

async function setDiscoverItemState(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const ref = str(args['itemId']);
  const state = oneOf(args['state'], DISCOVER_STATES);
  if (ref === undefined || state === undefined) return { error: 'itemId and a valid state are needed.' };
  const stamp = state === 'to-review'
    ? `, metadata = metadata || jsonb_build_object('restoredAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`
    : state === 'shelved' ? `, metadata = metadata || jsonb_build_object('shelvedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))` : '';
  const { rows } = await db.query<{ id: string; title: string }>(
    `UPDATE content_items SET workflow_state = $1${stamp}
      WHERE source = 'discovered-article' AND (id::text = $2 OR rtrim(url, '/') = rtrim($2, '/'))
      RETURNING id::text, title`,
    [state, ref],
  );
  if (rows.length === 0) return { error: 'No Discover article with that id or URL.' };
  return { success: true, updated: rows.map((r) => ({ id: r.id, title: r.title, state })) };
}

// ── Sparks ───────────────────────────────────────────────────────────────────

async function updateSpark(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const id = str(args['sparkId']);
  const body = str(args['body']);
  const tags = Array.isArray(args['tags']) ? (args['tags'] as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()) : null;
  if (id === undefined || (body === undefined && tags === null)) return { error: 'sparkId and a new body or tags are needed.' };
  const { rows } = await db.query<{ id: string; body: string; tags: string[] }>(
    `UPDATE sparks SET body = COALESCE($2, body), tags = COALESCE($3, tags) WHERE id::text = $1 RETURNING id::text, body, tags`,
    [id, body ?? null, tags],
  );
  if (rows.length === 0) return { error: 'Spark not found.' };
  return { success: true, spark: rows[0] };
}

// ── Projects ─────────────────────────────────────────────────────────────────

async function resolveProjectId(db: Pool, ref: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM projects WHERE id = $1 OR lower(name) = lower($1) ORDER BY (id = $1) DESC LIMIT 1`, [ref]);
  return rows[0]?.id ?? null;
}

function cleanTags(v: unknown): string[] | null {
  return Array.isArray(v) ? [...new Set((v as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()))] : null;
}

async function createProject(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const name = str(args['name']);
  if (name === undefined) return { error: 'name is required.' };
  if (await resolveProjectId(db, name) !== null) return { error: `A project called "${name}" already exists; use update_project.` };
  const slug = (str(args['id']) ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_PROJECT_ID_CHARS);
  const id = slug !== '' && await resolveProjectId(db, slug) === null ? slug : randomUUID();
  const tags = cleanTags(args['tags']) ?? [];
  await db.query(
    `INSERT INTO projects (id, name, colour, category, priority, project_type, description, goal, role, ownership, lifecycle_state, importance, expected_outputs, gitlab_paths, github_repos, links, tags)
     VALUES ($1, $2, 'gray', $3, $4, 'standard', $5, $6, '', '', 'active', $7, '{}', '{}', '{}', '[]', $8)`,
    [id, name, oneOf(args['category'], PROJECT_CATEGORIES) ?? 'work', oneOf(args['priority'], PROJECT_PRIORITIES) ?? 'medium',
      str(args['description']) ?? '', str(args['goal']) ?? '', oneOf(args['importance'], PROJECT_IMPORTANCE) ?? 'normal', tags],
  );
  return { success: true, project: { id, name }, url: `${env.FRONTEND_BASE_URL}/projects` };
}

async function updateProject(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const ref = str(args['projectId']);
  const id = ref === undefined ? null : await resolveProjectId(db, ref);
  if (id === null) return { error: 'Project not found. Use the id from the project catalogue.' };
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown): void => { if (v !== undefined && v !== null) { vals.push(v); sets.push(`${col} = $${vals.length.toString()}`); } };
  set('name', str(args['name']));
  set('description', typeof args['description'] === 'string' ? args['description'].trim() : undefined);
  set('goal', typeof args['goal'] === 'string' ? args['goal'].trim() : undefined);
  set('category', oneOf(args['category'], PROJECT_CATEGORIES));
  set('priority', oneOf(args['priority'], PROJECT_PRIORITIES));
  set('importance', oneOf(args['importance'], PROJECT_IMPORTANCE));
  set('lifecycle_state', oneOf(args['lifecycleState'], PROJECT_LIFECYCLE));
  set('tags', cleanTags(args['tags']));
  if (sets.length === 0) return { error: 'Nothing to change.' };
  vals.push(id);
  const { rows } = await db.query<{ id: string; name: string }>(
    `UPDATE projects SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length.toString()} RETURNING id, name`, vals);
  return { success: true, project: rows[0], changed: sets.map((s) => s.split(' = ')[0]) };
}

// ── Notes ────────────────────────────────────────────────────────────────────

async function updateNote(db: Pool, args: Record<string, unknown>, openNoteId?: string): Promise<unknown> {
  const id = str(args['noteId']);
  if (id === undefined) return { error: 'noteId is required.' };
  if (id === openNoteId) return { error: 'That note is open beside the chat: use propose_note_edit so the user can review the change.' };
  const content = typeof args['content'] === 'string' && args['content'].trim() !== '' ? args['content'] : undefined;
  const title = str(args['title']);
  const projectRef = str(args['projectId']);
  if (content === undefined && title === undefined && projectRef === undefined) return { error: 'Give content, a title or a projectId to change.' };
  const projectId = projectRef === undefined ? undefined : await resolveProjectId(db, projectRef);
  if (projectId === null) return { error: 'Project not found.' };

  const { writeNote } = await import('../services/noteVersionService.js');
  const { scheduleNoteIndexing } = await import('../routes/notes.js');
  const { rows } = await db.query<{ content: string; revision: number }>(`SELECT content, revision FROM notes WHERE id::text = $1 AND status = 'active'`, [id]);
  const row = rows[0];
  if (row === undefined) return { error: 'Note not found or archived.' };
  let wrapper: Record<string, unknown> = {};
  try { wrapper = JSON.parse(row.content) as Record<string, unknown>; } catch { wrapper = {}; }

  const mode = args['mode'] === 'replace' ? 'replace' : 'append';
  let note;
  if (content !== undefined && mode === 'append' && title === undefined && projectId === undefined) {
    note = await writeNote(db, id, { appendBlocks: textToBlocks(content) });
  } else {
    // Keep the current text in the note's history before Athena rewrites it.
    const protectedNote = mode === 'replace' && content !== undefined
      ? await writeNote(db, id, { content: row.content, expectedRevision: row.revision, protect: true })
      : { revision: row.revision };
    let blocks: unknown[] = [];
    try { blocks = JSON.parse(typeof wrapper['contentJson'] === 'string' ? wrapper['contentJson'] : '[]') as unknown[]; } catch { blocks = []; }
    if (content !== undefined) blocks = mode === 'replace' ? textToBlocks(content) : [...blocks, ...textToBlocks(content)];
    const next = { ...wrapper, ...(title !== undefined ? { title } : {}), contentJson: JSON.stringify(blocks) };
    note = await writeNote(db, id, {
      content: JSON.stringify(next), expectedRevision: protectedNote.revision,
      ...(projectId !== undefined ? { projectId } : {}),
    });
  }
  scheduleNoteIndexing(db, note);
  return { success: true, note: { id, title: title ?? wrapper['title'], url: `${env.FRONTEND_BASE_URL}/think?noteId=${id}` }, mode: content === undefined ? 'metadata' : mode };
}

// ── Diagrams ─────────────────────────────────────────────────────────────────

interface NodeSpec {
  key: string; label: string; description?: string; kind: typeof NODE_KINDS[number]; colour: string; footnote: boolean;
  /** AI flow: lane key, label or id. */
  lane?: string;
  flow?: AiFlowStep;
  /** Colour from the step type rather than a named colour. */
  stepStyle?: boolean;
}
interface EdgeSpec { from: string; to: string; label: string; dashed: boolean; flow?: AiFlowEdge }
export interface LaneSpec { key: string; label: string; owner?: string; description?: string }

// AI flow values are trimmed and clipped to the validator's limits so a long model answer never fails the save.
const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const flowText = (v: unknown): string | undefined => str(v)?.slice(0, DIAGRAM_LIMITS.maxFlowTextChars);
const flowList = (v: unknown): string[] | undefined => {
  const items = (Array.isArray(v) ? v : [v]).flatMap((x) => { const s = str(x); return s === undefined ? [] : [s.slice(0, DIAGRAM_LIMITS.maxFlowListItemChars)]; })
    .slice(0, DIAGRAM_LIMITS.maxFlowListItems);
  return items.length > 0 ? items : undefined;
};
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
/** 0–1; a percentage (e.g. 85) is converted. */
const threshold = (v: unknown): number | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  const t = v > 1 && v <= PERCENTAGE_MAX ? v / PERCENTAGE_MAX : v;
  return t <= 1 ? t : undefined;
};
/** Merges defined incoming values over existing ones; undefined when nothing is left. */
function merged<T extends object>(existing: T | undefined, incoming: { [K in keyof T]?: T[K] | undefined }): T | undefined {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length > 0 ? out as T : undefined;
}

function flowStepFrom(n: Record<string, unknown>, existing?: AiFlowStep): AiFlowStep | undefined {
  const stepType = oneOf(currentStepType(n['stepType']), AI_FLOW_STEP_TYPES) ?? existing?.stepType;
  if (stepType === undefined) return undefined;
  const a = record(n['agent']);
  const c = record(n['controls']);
  const o = record(n['operations']);
  const agent = merged<AiFlowAgent>(existing?.agent, {
    role: flowText(a['role']), mode: oneOf(a['mode'], AI_AGENT_MODES), assertion: oneOf(a['assertion'], AI_ASSERTION_LEVELS),
    orchestrator: flowText(a['orchestrator']), tools: flowList(a['tools']), knowledge: flowList(a['knowledge']),
    guardrails: flowList(a['guardrails']), escalationPath: flowText(a['escalationPath']), decisionBoundary: flowText(a['decisionBoundary']),
    confidenceThreshold: threshold(a['confidenceThreshold']), memory: oneOf(a['memory'], AI_MEMORY_SCOPES),
    model: flowText(a['model']), promptVersion: flowText(a['promptVersion']),
  });
  const controls = merged<AiFlowControls>(existing?.controls, {
    sensitivity: oneOf(c['sensitivity'], DATA_SENSITIVITIES), authRequired: flag(c['authRequired']), authModel: flowText(c['authModel']),
    auditLogging: flag(c['auditLogging']), humanApproval: flag(c['humanApproval']), regulatoryTags: flowList(c['regulatoryTags']),
  });
  const operations = merged<AiFlowOperations>(existing?.operations, {
    volume: oneOf(o['volume'], AI_FLOW_VOLUMES), sla: flowText(o['sla']), failureHandling: flowText(o['failureHandling']), monitoring: flowText(o['monitoring']),
  });
  const gate = stepType === 'decision_gate' ? gateFrom(record(n['gate']), existing?.gate) : undefined;
  const step = merged<AiFlowStep>({ ...existing, stepType }, {
    state: oneOf(n['state'], AI_FLOW_STATES), actor: flowText(n['actor']),
    systems: flowList(n['systems']), dataIn: flowList(n['dataIn']), dataOut: flowList(n['dataOut']), agent, controls, operations, gate,
  });
  if (step !== undefined && stepType !== 'decision_gate') delete step.gate;
  return step;
}

function gateFrom(g: Record<string, unknown>, existing?: AiFlowGate): AiFlowGate {
  const d = record(g['delegation']);
  const a = record(g['acceptance']);
  const s = record(g['shared']);
  const delegation = merged<AiFlowGateDelegation>(existing?.delegation, {
    permittedWork: flowText(d['permittedWork']), authorityLimits: flowText(d['authorityLimits']), requiredInputs: flowList(d['requiredInputs']),
    obligations: flowList(d['obligations']), approvalConditions: flowText(d['approvalConditions']), evidence: flowList(d['evidence']),
    onFail: oneOf(d['onFail'], AI_GATE_DELEGATION_FAILURES),
  });
  const acceptance = merged<AiFlowGateAcceptance>(existing?.acceptance, {
    requiredOutputs: flowList(a['requiredOutputs']), validationCriteria: flowText(a['validationCriteria']), uncertaintyHandling: flowText(a['uncertaintyHandling']),
    humanReviewConditions: flowText(a['humanReviewConditions']), evidence: flowList(a['evidence']), onFail: oneOf(a['onFail'], AI_GATE_ACCEPTANCE_FAILURES),
  });
  const shared = merged<AiFlowGateShared>(existing?.shared, {
    accountableOwner: flowText(s['accountableOwner']), controlRefs: flowList(s['controlRefs']), enforcedBy: flowText(s['enforcedBy']),
    overrideAuthority: flowText(s['overrideAuthority']), pendingBehaviour: flowText(s['pendingBehaviour']), recordRequirements: flowList(s['recordRequirements']),
  });
  return merged<AiFlowGate>({ ...existing, gateKind: oneOf(g['gateKind'], AI_GATE_KINDS) ?? existing?.gateKind ?? 'delegation_acceptance' }, { delegation, acceptance, shared })!;
}

/** Connector metadata; in an AI flow an untyped connector is the primary flow. */
function flowEdgeFrom(e: Record<string, unknown>, aiFlow: boolean, existing?: AiFlowEdge): AiFlowEdge | undefined {
  const rest = {
    interaction: oneOf(e['interaction'], AI_FLOW_INTERACTIONS), payload: flowText(e['payload']),
    sensitivity: oneOf(e['sensitivity'], DATA_SENSITIVITIES), auth: flowText(e['auth']), condition: flowText(e['condition']),
    gateEvaluation: oneOf(e['gateEvaluation'], AI_GATE_EVALUATIONS), gateOutcome: oneOf(e['gateOutcome'], AI_GATE_OUTCOMES),
  };
  const edgeType = oneOf(e['edgeType'], AI_FLOW_EDGE_TYPES) ?? existing?.edgeType
    ?? (aiFlow || Object.values(rest).some((v) => v !== undefined) ? 'primary_flow' : undefined);
  return edgeType === undefined ? undefined : merged<AiFlowEdge>({ ...existing, edgeType }, rest);
}

function laneSpecs(v: unknown): LaneSpec[] {
  return (Array.isArray(v) ? v as unknown[] : []).flatMap((raw) => {
    const l = record(raw);
    const label = str(l['label']);
    if (label === undefined) return [];
    const owner = flowText(l['owner']);
    const description = str(l['description'])?.slice(0, MAX_LANE_DESCRIPTION_CHARS);
    return [{ key: str(l['key']) ?? label, label, ...(owner !== undefined ? { owner } : {}), ...(description !== undefined ? { description } : {}) }];
  });
}

function nodeSpecs(v: unknown): NodeSpec[] {
  return (Array.isArray(v) ? v as Array<Record<string, unknown>> : []).flatMap((n) => {
    const label = str(n['label']);
    if (label === undefined) return [];
    const description = str(n['description']);
    const flow = flowStepFrom(n);
    const colour = oneOf(n['colour'], COLOUR_NAMES);
    const lane = str(n['lane']);
    return [{
      key: str(n['key']) ?? label, label, ...(description !== undefined ? { description } : {}),
      kind: oneOf(n['kind'], NODE_KINDS) ?? (flow !== undefined ? STEP_STYLES[flow.stepType].kind : 'process'),
      colour: colour ?? 'grey', footnote: n['footnote'] === true,
      ...(lane !== undefined ? { lane } : {}),
      ...(flow !== undefined ? { flow, ...(colour === undefined ? { stepStyle: true } : {}) } : {}),
    }];
  });
}

function edgeSpecs(v: unknown, aiFlow = false): EdgeSpec[] {
  return (Array.isArray(v) ? v as Array<Record<string, unknown>> : []).flatMap((e) => {
    const from = str(e['from']);
    const to = str(e['to']);
    if (from === undefined || to === undefined) return [];
    const flow = flowEdgeFrom(e, aiFlow);
    const dashed = typeof e['dashed'] === 'boolean' ? e['dashed'] : flow !== undefined && EDGE_STYLES[flow.edgeType].dashed;
    return [{ from, to, label: str(e['label']) ?? '', dashed, ...(flow !== undefined ? { flow } : {}) }];
  });
}

function makeNode(spec: NodeSpec, x: number, y: number): DiagramNode {
  const style = spec.flow !== undefined ? STEP_STYLES[spec.flow.stepType] : undefined;
  const size = style !== undefined && style.kind === spec.kind ? style : NODE_SIZE[spec.kind];
  const colour = style !== undefined && spec.stepStyle === true ? style : DIAGRAM_COLOURS[spec.colour] ?? DIAGRAM_COLOURS['grey']!;
  return {
    id: randomUUID(), kind: spec.kind as DiagramKind, label: spec.label, ...(spec.description !== undefined ? { description: spec.description } : {}),
    x, y, width: size.width, height: size.height, parentId: null, fill: colour.fill, stroke: colour.stroke,
    textColor: '#161616', fontSize: 16, assetId: null, ...(spec.flow !== undefined ? { flow: spec.flow } : {}),
  };
}

function makeEdge(sourceId: string, targetId: string, spec: EdgeSpec): DiagramEdge {
  return {
    id: randomUUID(), sourceId, targetId, sourcePort: 'right', targetPort: 'left', route: 'orthogonal', waypoints: [],
    label: spec.label, stroke: spec.flow !== undefined ? EDGE_STYLES[spec.flow.edgeType].stroke : '#525252', dashed: spec.dashed, arrows: 'end',
    ...(spec.flow !== undefined ? { flow: spec.flow } : {}),
  };
}

function makeLane(spec: LaneSpec, order: number): DiagramNode {
  return {
    id: randomUUID(), kind: 'swimlane', label: spec.label, x: 0, y: 0, width: 560, height: 180, parentId: null,
    fill: '#ffffff', stroke: '#525252', textColor: '#161616', fontSize: 18, assetId: null,
    lane: { order, ...(spec.owner !== undefined ? { owner: spec.owner } : {}), ...(spec.description !== undefined ? { description: spec.description } : {}) },
  };
}

/** Finds a lane by key (this call), id or label (case-insensitive). */
function findLane(doc: DiagramDocument, ref: string, keys: Map<string, string>): DiagramNode | undefined {
  const id = keys.get(ref.toLowerCase()) ?? ref;
  const lanes = doc.nodes.filter((n) => n.kind === 'swimlane');
  return lanes.find((n) => n.id === id) ?? lanes.find((n) => n.label.trim().toLowerCase() === ref.trim().toLowerCase());
}

/**
 * Adds lanes, steps (placed in their lanes) and connectors to an AI flow, then
 * lays it out as swimlanes. Steps whose lane can't be found stay outside lanes.
 */
export function addToAiFlow(doc: DiagramDocument, lanes: LaneSpec[], nodes: NodeSpec[], edges: EdgeSpec[]): { doc: DiagramDocument; problems: string[] } {
  const firstOrder = nextLaneOrder(doc);
  const laneKeys = new Map<string, string>();
  const newLanes = lanes.map((spec, i) => {
    const lane = makeLane(spec, firstOrder + i);
    laneKeys.set(spec.key.toLowerCase(), lane.id);
    return lane;
  });
  const withLanes: DiagramDocument = { ...doc, diagramType: 'ai-flow', nodes: [...doc.nodes, ...newLanes] };
  const added = addToDiagram(withLanes, nodes, edges);
  const problems = [...added.problems];
  const offset = added.doc.nodes.length - nodes.length;
  nodes.forEach((spec, i) => {
    const node = added.doc.nodes[offset + i]!;
    if (spec.lane === undefined) {
      if (newLanes.length > 0 || doc.nodes.some((n) => n.kind === 'swimlane')) problems.push(`Step "${spec.label}" has no lane.`);
      return;
    }
    const lane = findLane(added.doc, spec.lane, laneKeys);
    if (lane === undefined) problems.push(`Lane "${spec.lane}" not found; "${spec.label}" is outside the lanes.`);
    else node.parentId = lane.id;
  });
  return { doc: layoutAiFlow(added.doc), problems };
}

/** Advisory governance gaps for the tool result. */
function governanceSummary(doc: DiagramDocument): Record<string, unknown> {
  const findings = checkAiFlow(doc);
  const count = (s: string): number => findings.filter((f) => f.severity === s).length;
  return {
    high: count('high'), warnings: count('warning'), info: count('info'),
    top: findings.slice(0, MAX_GOVERNANCE_FINDINGS).map((f) => `${f.severity}: ${f.message}`),
    ...(findings.length > MAX_GOVERNANCE_FINDINGS ? { more: findings.length - MAX_GOVERNANCE_FINDINGS } : {}),
    note: 'Advisory checks for governance details not recorded on the diagram. Tell the user about the high ones and ask for the missing details; do not invent controls to clear them.',
  };
}

/** Feedback loops do not participate in longest-path ranking. */
export function layoutColumns(keys: string[], edges: Array<{ from: string; to: string }>): Map<string, number> {
  return rankFlowNodes(keys, edges);
}

/** Finds a shape by id, or by label (case-insensitive) when unambiguous. */
function findNode(doc: DiagramDocument, ref: string, extra: Map<string, string> = new Map()): DiagramNode | string {
  const byKey = extra.get(ref) ?? extra.get(ref.toLowerCase());
  if (byKey !== undefined) return doc.nodes.find((n) => n.id === byKey) ?? `Shape "${ref}" not found.`;
  const byId = doc.nodes.find((n) => n.id === ref);
  if (byId !== undefined) return byId;
  const byLabel = doc.nodes.filter((n) => n.label.trim().toLowerCase() === ref.trim().toLowerCase());
  if (byLabel.length === 1) return byLabel[0]!;
  return byLabel.length > 1 ? `More than one shape is labelled "${ref}"; use its id.` : `Shape "${ref}" not found.`;
}

function legendFrom(v: unknown, existing: DiagramDocument['legend']): DiagramDocument['legend'] {
  if (!Array.isArray(v)) return existing;
  const entries = (v as Array<Record<string, unknown>>).flatMap((e) => {
    const colour = oneOf(e['colour'], COLOUR_NAMES);
    const label = str(e['label']);
    return colour === undefined || label === undefined ? [] : [{ colour: DIAGRAM_COLOURS[colour]!.stroke, label }];
  });
  return { visible: entries.length > 0, position: existing?.position ?? 'top-right', entries };
}

/** Adds shapes (placed to the right of anything already there) and connectors to a document. */
export function addToDiagram(doc: DiagramDocument, nodes: NodeSpec[], edges: EdgeSpec[]): { doc: DiagramDocument; problems: string[] } {
  const problems: string[] = [];
  const startX = doc.nodes.length === 0 ? LAYOUT.left : Math.max(...doc.nodes.map((n) => n.x + n.width)) + LAYOUT.gap;
  const keyToId = new Map<string, string>();
  const added: DiagramNode[] = [];
  for (const spec of nodes) {
    const node = makeNode(spec, startX, LAYOUT.top);
    keyToId.set(spec.key.toLowerCase(), node.id);
    added.push(node);
  }
  const next: DiagramDocument = { ...doc, nodes: [...doc.nodes, ...added], edges: [...doc.edges], footnotes: [...(doc.footnotes ?? [])] };
  nodes.forEach((spec, i) => {
    if (spec.footnote) next.footnotes!.push({ id: randomUUID(), targetId: added[i]!.id, source: 'description' });
  });
  for (const e of edges) {
    const from = findNode(next, e.from, keyToId);
    const to = findNode(next, e.to, keyToId);
    if (typeof from === 'string' || typeof to === 'string') { problems.push(typeof from === 'string' ? from : to as string); continue; }
    next.edges.push(makeEdge(from.id, to.id, e));
  }
  if (next.footnotes!.length === 0) delete next.footnotes;
  if (added.length === 0) return { doc: next, problems };
  const addedIds = new Set(added.map(node => node.id));
  const placed = layoutGeneralDiagram({ ...next, nodes: added,
    edges: next.edges.filter(edge => addedIds.has(edge.sourceId) && addedIds.has(edge.targetId)) }, { x: startX, y: LAYOUT.top });
  const placedEdges = new Map(placed.edges.map(edge => [edge.id, edge]));
  return { doc: { ...next, nodes: [...doc.nodes, ...placed.nodes],
    edges: next.edges.map(edge => placedEdges.get(edge.id) ?? edge) }, problems };
}

async function createDiagram(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const title = str(args['title']);
  const nodes = nodeSpecs(args['nodes']);
  if (title === undefined || nodes.length === 0) return { error: 'A title and at least one shape are needed.' };
  if (nodes.length > MAX_DIAGRAM_NODES) return { error: `At most ${MAX_DIAGRAM_NODES.toString()} shapes per call.` };
  const projectRef = str(args['projectId']);
  const project = projectRef === undefined ? null : await resolveProjectId(db, projectRef);
  const { createCanvas, updateCanvas } = await import('../services/canvasService.js');
  const { getDiagram, saveDiagram } = await import('../services/diagramService.js');
  const { emptyDiagram } = await import('../types/diagram.js');
  const lanes = laneSpecs(args['lanes']);
  const aiFlow = args['diagramType'] === 'ai-flow' || (args['diagramType'] !== 'general' && lanes.length > 0);
  if (lanes.length + nodes.length > MAX_DIAGRAM_NODES) return { error: `At most ${MAX_DIAGRAM_NODES.toString()} lanes and shapes per call.` };
  const edges = edgeSpecs(args['edges'], aiFlow);
  const { doc, problems } = aiFlow ? addToAiFlow(emptyDiagram(), lanes, nodes, edges) : addToDiagram(emptyDiagram(), nodes, edges);
  const legend = legendFrom(args['legend'], undefined);
  const canvas = await createCanvas({ title, canvasType: 'diagram', ...(project !== null ? { project } : {}) });
  const description = str(args['description']);
  if (description !== undefined) await updateCanvas(canvas.id, { description });
  const current = await getDiagram(canvas.id);
  await saveDiagram(canvas.id, { revision: current.revision, document: { ...doc, ...(legend !== undefined ? { legend } : {}) } });
  return {
    success: true, diagram: { id: canvas.id, title, shapes: doc.nodes.length, connectors: doc.edges.length, ...(aiFlow ? { type: 'ai-flow', lanes: lanes.length } : {}) },
    url: `${env.FRONTEND_BASE_URL}/think?mapId=${canvas.id}`,
    ...(problems.length > 0 ? { [aiFlow ? 'problems' : 'skippedConnectors']: problems } : {}),
    ...(aiFlow ? { governance: governanceSummary(doc) } : {}),
  };
}

/** Finds a connector by id, or by its source and target shapes. */
function findEdge(doc: DiagramDocument, u: Record<string, unknown>): DiagramEdge | string {
  const id = str(u['edge']);
  if (id !== undefined) return doc.edges.find((e) => e.id === id) ?? `Connector "${id}" not found.`;
  const fromRef = str(u['from']);
  const toRef = str(u['to']);
  if (fromRef === undefined || toRef === undefined) return 'Each connector update needs edge, or from and to.';
  const from = findNode(doc, fromRef);
  const to = findNode(doc, toRef);
  if (typeof from === 'string' || typeof to === 'string') return typeof from === 'string' ? from : to as string;
  const matches = doc.edges.filter((e) => e.sourceId === from.id && e.targetId === to.id);
  if (matches.length === 1) return matches[0]!;
  return matches.length > 1 ? `More than one connector runs from "${fromRef}" to "${toRef}"; use its id.` : `No connector from "${fromRef}" to "${toRef}".`;
}

/** Applies update_diagram's changes to a copy of a document. */
export function applyDiagramUpdate(current: DiagramDocument, args: Record<string, unknown>): { doc: DiagramDocument; problems: string[] } {
  let doc: DiagramDocument = structuredClone(current);
  const problems: string[] = [];
  const type = args['diagramType'];
  if (type === 'ai-flow') doc.diagramType = 'ai-flow';
  else if (type === 'general') delete doc.diagramType;
  let relayout = args['relayout'] === true;

  for (const ref of Array.isArray(args['removeNodes']) ? args['removeNodes'] as unknown[] : []) {
    if (typeof ref !== 'string') continue;
    const node = findNode(doc, ref);
    if (typeof node === 'string') { problems.push(node); continue; }
    const gone = new Set([node.id, ...doc.edges.filter((e) => e.sourceId === node.id || e.targetId === node.id).map((e) => e.id)]);
    doc = {
      ...doc,
      nodes: doc.nodes.filter((n) => n.id !== node.id).map((n) => (n.parentId === node.id ? { ...n, parentId: null } : n)),
      edges: doc.edges.filter((e) => !gone.has(e.id)),
      ...(doc.footnotes !== undefined ? { footnotes: doc.footnotes.filter((f) => !gone.has(f.targetId)) } : {}),
    };
  }
  for (const u of Array.isArray(args['updateNodes']) ? args['updateNodes'] as Array<Record<string, unknown>> : []) {
    const ref = str(u['node']);
    const node = ref === undefined ? 'Each update needs a node.' : findNode(doc, ref);
    if (typeof node === 'string') { problems.push(node); continue; }
    const label = str(u['label']);
    const description = str(u['description']);
    const colour = oneOf(u['colour'], COLOUR_NAMES);
    if (label !== undefined) node.label = label;
    if (description !== undefined) node.description = description;
    if (colour !== undefined) { node.fill = DIAGRAM_COLOURS[colour]!.fill; node.stroke = DIAGRAM_COLOURS[colour]!.stroke; }
    if (u['footnote'] === true && !(doc.footnotes ?? []).some((f) => f.targetId === node.id)) {
      doc.footnotes = [...(doc.footnotes ?? []), { id: randomUUID(), targetId: node.id, source: 'description' }];
    }
    if (node.kind === 'swimlane') {
      const owner = flowText(u['owner']);
      const order = typeof u['order'] === 'number' && Number.isFinite(u['order']) && Math.abs(u['order']) <= DIAGRAM_LIMITS.maxLaneOrder ? u['order'] : undefined;
      if (owner !== undefined || order !== undefined || (doc.diagramType === 'ai-flow' && node.lane === undefined)) {
        node.lane = { ...node.lane, order: order ?? node.lane?.order ?? nextLaneOrder(doc), ...(owner !== undefined ? { owner } : {}) };
        relayout = true;
      }
      continue;
    }
    if ((NODE_KINDS as readonly string[]).includes(node.kind)) {
      const flow = flowStepFrom(u, node.flow);
      if (flow !== undefined) node.flow = flow;
      else if (u['stepType'] !== undefined || u['agent'] !== undefined || u['controls'] !== undefined) problems.push(`"${node.label}" needs a stepType before AI flow details can be set.`);
    }
    const laneRef = str(u['lane']);
    if (laneRef !== undefined) {
      const lane = findLane(doc, laneRef, new Map());
      if (lane === undefined) problems.push(`Lane "${laneRef}" not found.`);
      else { node.parentId = lane.id; relayout = true; }
    }
  }
  for (const u of Array.isArray(args['updateEdges']) ? args['updateEdges'] as Array<Record<string, unknown>> : []) {
    const edge = findEdge(doc, u);
    if (typeof edge === 'string') { problems.push(edge); continue; }
    const label = str(u['label']);
    if (label !== undefined) edge.label = label;
    const flow = flowEdgeFrom(u, doc.diagramType === 'ai-flow', edge.flow);
    if (flow !== undefined) {
      const typeChanged = flow.edgeType !== edge.flow?.edgeType;
      edge.flow = flow;
      if (typeChanged) { edge.stroke = EDGE_STYLES[flow.edgeType].stroke; edge.dashed = EDGE_STYLES[flow.edgeType].dashed; }
    }
    if (typeof u['dashed'] === 'boolean') edge.dashed = u['dashed'];
  }
  const lanes = laneSpecs(args['addLanes']);
  const nodes = nodeSpecs(args['addNodes']);
  const edges = edgeSpecs(args['addEdges'], doc.diagramType === 'ai-flow' || lanes.length > 0);
  if (lanes.length > 0 || (doc.diagramType === 'ai-flow' && (nodes.length > 0 || edges.length > 0))) {
    const added = addToAiFlow(doc, lanes, nodes, edges);
    doc = added.doc;
    problems.push(...added.problems);
    relayout = false;
  } else if (nodes.length > 0 || edges.length > 0) {
    const added = addToDiagram(doc, nodes, edges);
    doc = added.doc;
    problems.push(...added.problems);
  }
  if (relayout) {
    if (doc.diagramType === 'ai-flow') doc = layoutAiFlow(doc);
    else if (args['relayout'] === true) doc = layoutGeneralDiagram(doc);
  }
  const legend = legendFrom(args['legend'], doc.legend);
  if (legend !== undefined) doc.legend = legend;
  return { doc, problems };
}

async function updateDiagram(args: Record<string, unknown>): Promise<unknown> {
  const id = str(args['diagramId']);
  if (id === undefined) return { error: 'diagramId is required.' };
  const { getDiagram, saveDiagram, getCanvasType } = await import('../services/diagramService.js');
  if (await getCanvasType(id) !== 'diagram') return { error: 'Diagram not found.' };
  const { updateCanvas } = await import('../services/canvasService.js');
  const current = await getDiagram(id);
  const { doc, problems } = applyDiagramUpdate(current.document, args);
  if (doc.nodes.length > MAX_DIAGRAM_NODES * 4) return { error: 'That would make the diagram too large.' };

  const saved = await saveDiagram(id, { revision: current.revision, document: doc });
  const title = str(args['title']);
  if (title !== undefined) await updateCanvas(id, { title });
  return {
    success: true, diagram: { id, shapes: saved.document.nodes.length, connectors: saved.document.edges.length, revision: saved.revision },
    url: `${env.FRONTEND_BASE_URL}/think?mapId=${id}`,
    note: 'Saved. If the diagram is open in the editor, tell the user to reopen it to see the changes.',
    ...(problems.length > 0 ? { problems } : {}),
    ...(saved.document.diagramType === 'ai-flow' ? { governance: governanceSummary(saved.document) } : {}),
  };
}

// ── Mind maps ────────────────────────────────────────────────────────────────

async function createMindMap(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const title = str(args['title']);
  const ideas = (Array.isArray(args['ideas']) ? args['ideas'] as Array<Record<string, unknown>> : [])
    .flatMap((i) => { const label = str(i['label']); return label === undefined ? [] : [{ label, body: str(i['body']), parent: str(i['parent']) }]; });
  if (title === undefined || ideas.length === 0) return { error: 'A title and at least one idea are needed.' };
  if (ideas.length > MAX_MAP_IDEAS) return { error: `At most ${MAX_MAP_IDEAS.toString()} ideas per map.` };
  const projectRef = str(args['projectId']);
  const project = projectRef === undefined ? null : await resolveProjectId(db, projectRef);
  const { createCanvas, applyOps } = await import('../services/canvasService.js');
  const canvas = await createCanvas({ title, rootLabel: str(args['centre']) ?? title, ...(project !== null ? { project } : {}) });
  const rootId = canvas.nodes[0]?.id;
  if (rootId === undefined) return { error: 'Could not create the map.' };
  const ids = new Map<string, string>();
  const ops = ideas.map((idea) => {
    const id = randomUUID();
    const parent = idea.parent !== undefined ? ids.get(idea.parent.toLowerCase()) ?? rootId : rootId;
    ids.set(idea.label.toLowerCase(), id);
    return {
      op: 'add' as const, id, label: idea.label, ...(idea.body !== undefined ? { body: idea.body } : {}),
      connectTo: { nodeId: parent, edgeId: randomUUID() },
    };
  });
  await applyOps(canvas.id, ops);
  return { success: true, map: { id: canvas.id, title, ideas: ideas.length }, url: `${env.FRONTEND_BASE_URL}/think?mapId=${canvas.id}` };
}
