/**
 * AI chat tools — function-calling handlers the model can invoke mid-conversation.
 *
 * Capabilities include:
 *   1. search_knowledge_base — read-only FTS query across everything indexed
 *      in content_items (commits, PRs, issues, releases, emails, calendar,
 *      notes, discovered articles, tasks-adjacent content, etc.).
 *   2. create_task / update_task — Plan board (Kanban) task CRUD.
 *   3. create_note_draft — Think section document draft creation.
 *   4. create_spark — capture a brief thought in Sparks.
 *
 * These execute immediately (no separate confirm step) — they only ever
 * touch the user's own internal Postgres data (tasks/notes/sparks), unlike the
 * higher-risk external write actions in writeActionService.ts (GitHub issues,
 * CMS publish, MS Todo push), which still require explicit confirmation.
 */

import { validateNoteEdits, checkEditsAgainstNote, noteHeadings } from './noteEdits.js';
import { JOB_TOOL, executeJobTool } from './jobTools.js';
import { PUBLISHING_TOOL, executePublishingTool } from './publishingTools.js';
import { executeDesignTool, type DesignTurnState } from './designTools.js';
import type { NoteEditProposal } from './noteEdits.js';
import { createMemory, listMemories, deleteMemory } from './athenaMemory.js';
import type { Pool } from 'pg';
import { saveOutputVersion, getOutput, readOutputForChat } from './chatOutputs.js';
import { buildTodayScheduleBlock } from '../integrations/ibm/ibmMeetings.js';
import { textToBlocks } from './markdownToNoteBlocks.js';
import { DEMO_SPECIFICATION_TOOLS, demoSpecificationForm, renderDemoSpecification } from './demoSpecification.js';
export { textToBlocks } from './markdownToNoteBlocks.js';
import { FoundryClient, type LlmToolDefinition } from './foundryClient.js';
import { AGENT_TOOL_NAMES, agentToolDefinitions, executeAgentTool } from './agentTools.js';
import { executeLocalFileTool, LOCAL_FILE_TOOL_NAMES, type LocalFileWriteProposal, type LocalFolder } from './localFiles.js';
import { getProjectContextItems, getRagItems, getContentItemsByIds } from '../db/queries.js';
import { isFoundryIqEnabled, retrieveContentItemIds } from './foundryIqClient.js';
import { createDbSearchBackends, searchKnowledge, searchFilterSql } from '../services/knowledge/search.js';
import { isOutsideCollectionTool, resolveSearchFilter, RetrievalScopeError, type RetrievalScope, type RetrievalAudit } from './knowledge/retrievalScope.js';
import { canonicalContentSql } from '../db/contentVisibility.js';
import { createNoteRecord } from '../routes/notes.js';
import { rowToTask, type Task } from '../routes/tasks.js';
import { TASK_STATUSES, normaliseTaskStatus } from '../services/taskStatus.js';
import { CONTENT_STORE } from '../routes/documents.js';
import { AI_TOOL_SEARCH_DEFAULT_LIMIT, AI_TOOL_SEARCH_MAX_LIMIT } from '../config/constants.js';
import { env } from '../config/env.js';
import { queueAutoTag } from '../services/autoTagging.js';
import { takeScreenshots, isScreenshotServiceConfigured, type ShotDevice } from '../services/screenshotClient.js';
import { addScreenUnread } from './chatScreens.js';
import { isIcaEnabled, icaChat } from './icaClient.js';
import { renderNoteAsText } from '../services/noteTextService.js';
import { getLearnMcpTools, isLearnMcpTool, callLearnMcpTool } from './learnMcpClient.js';
import { getTavilyMcpTools, isTavilyMcpTool, callTavilyMcpTool } from './tavilyMcpClient.js';
import { resolveMapChanges, type MapChangeProposal } from './mapEdits.js';
import type { CanvasFull } from '../services/canvasService.js';
import { findDiagramContext, readDiagramPage } from '../services/diagramContext.js';
import { createSpark } from '../services/sparkService.js';
import { loadCurrentProjectContext } from './projectContext.js';
import { EXCLUSION_GATED_TOOLS, EXCLUSIONS_UNAVAILABLE_RESULT, executeReadKnowledgeRecord } from '../services/knowledge/tool.js';
import { executeTraverseRelationships } from './knowledge/traversalLoader.js';
import { isKnowledgeOrchestrationEnabled, searchContentPreview } from './knowledge/budgets.js';
import { STRUCTURED_TOOL_DEFINITIONS, STRUCTURED_TOOL_NAMES, executeStructuredTool } from './knowledge/structuredTools.js';
import { getDiscoverSources, inspectDiscoverFeed } from './discoveryContext.js';
import { retrieveWatchlistRecords } from '../services/discoverWatchlists.js';
import { getAssetToolDefinitions, isAssetTool, executeAssetTool } from './assetTools.js';
import { searchKnowledgeGraph as searchGraph } from './graphInference.js';
import { readPublicPage, readingExcerpt } from '../utils/articleReading.js';
import { REVIEW_DECISIONS_DEFINITION, REVIEW_DECISIONS_TOOL, executeReviewDecisions } from './semanticDecisionReview.js';
import { searchPastChats, readPastChat, PAST_CHAT_SEARCH_DEFAULT_LIMIT, PAST_CHAT_SEARCH_MAX_LIMIT, PAST_CHAT_READ_DEFAULT_MESSAGES } from './chatSessionStore.js';
/** Cap on how much note text (including image vision analysis) we hand to the model per result. */
const NOTE_CONTENT_MAX_CHARS = 6000;
const DIAGRAM_SEARCH_PREVIEW_CHARS = 1000;

const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const NOTE_CONTENT_TYPES = [
  'blog', 'podcast', 'podcast-show-notes', 'newsletter', 'project', 'note', 'script', 'architecture', 'meeting', 'research', 'spec', 'use-case',
] as const;
const DEFAULT_ATHENA_NOTE_PROJECT_ID = 'ibm-thought-leadership';

export async function getToolDefinitions(): Promise<LlmToolDefinition[]> {
  const learnTools = await getLearnMcpTools();
  const tavilyTools = await getTavilyMcpTools();
  return [
    JOB_TOOL,
    PUBLISHING_TOOL,
    ...agentToolDefinitions(),
    ...DEMO_SPECIFICATION_TOOLS,
    REVIEW_DECISIONS_DEFINITION,
    {
      type: 'function',
      function: {
        name: 'get_discover_watchlist_records',
        description: 'Retrieve private saved Discover Watchlists and their dated evidence-linked findings, comparison baseline versions, and coverage. With no ID lists configured watchlists; with an ID returns dated runs. Use for what changed this month, comparison with our proposition, or new capability versus wording. No new research. Cite article URLs and run date/baseline version; do not confuse missing coverage with no meaningful change.',
        parameters: { type: 'object', properties: {
          watchlistId: { type: 'string' }, from: { type: 'string', description: 'Inclusive YYYY-MM-DD' },
          to: { type: 'string', description: 'Inclusive YYYY-MM-DD' },
        } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_discover_sources',
        description: 'Reads the actual configured RSS/Atom feed URLs, groups, enabled/disabled state and last check errors for Discover. App-wide, not project-scoped. Always use before recommending additional feeds; exclude configured feeds including disabled ones. Not the knowledge library or integration sync list.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'inspect_discover_feed',
        description: 'Checks a candidate RSS/Atom feed using the app feed reader and compares it against existing subscriptions. Read-only: does not add sources or import articles. Use to verify actual feed URLs before recommending them; duplicates are not new recommendations.',
        parameters: { type: 'object', properties: { feedUrl: { type: 'string', description: 'Public RSS/Atom feed URL, not an individual article URL.' } }, required: ['feedUrl'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_past_chats',
        description: 'Searches EVERY saved Athena conversation (from mobile, desktop and Think-note chats) by title and message text. Use whenever the user mentions an earlier conversation, a chat on another device, or something "we discussed". Returns chat titles, dates, a matching excerpt, and a link. Follow up with read_past_chat to read one.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'A few distinctive words or a phrase from the earlier conversation.' },
            limit: { type: 'number', description: 'Max chats to return (default 8, max 20).' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_past_chat',
        description: 'Reads one saved conversation found with search_past_chats. Without query returns the most recent 40 messages; with query returns up to 8 matching messages with full relevant excerpts, oldest first.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'sessionId from search_past_chats.' },
            query: { type: 'string', description: 'Optional topic words to retrieve matching messages without silently truncating the rest of the chat.' },
          },
          required: ['sessionId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_project_details',
        description: 'Reads the current saved Projects record: goal, user role, ownership, state, dates, importance, expected outputs, references and repositories. Use this for any named project before relying on older chat history or memories. Defaults to the conversation project only when projectId is omitted.',
        parameters: {
          type: 'object',
          properties: { projectId: { type: 'string', description: 'Saved project ID from the projects catalog. May be omitted when this chat has an assigned project.' } },
        },
      },
    },
    ...(isIcaEnabled() ? [{
      type: 'function' as const,
      function: {
        name: 'search_ica',
        description:
          'Queries ICA — IBM\'s internal Gen AI gateway — for ibm.com-domain work context (IBM-internal ' +
          'projects, initiatives, and material) that search_knowledge_base cannot see, since IBM does not ' +
          'permit that data to flow through the Alliance-tenant integrations this app otherwise uses. Use ' +
          'this for questions specifically about IBM-internal work (e.g. ATOM/ACRE, IBM-side IMAGINE detail, ' +
          'internal IBM initiatives) that search_knowledge_base alone would not have visibility into. For a ' +
          'question that spans both IBM-internal and Alliance-tenant/personal context, call both tools and ' +
          'synthesise the results into one answer — do not treat them as alternatives, they cover disjoint data.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The question or topic to ask ICA about.' },
          },
          required: ['query'],
        },
      },
    }] : []),
    {
      type: 'function',
      function: {
        name: 'search_knowledge_base',
        description:
          'Full-text search across everything indexed in the knowledge hub: GitHub/GitLab commits, pull ' +
          'requests, issues, releases, deployments, calendar events, emails, blog posts, discovered articles, ' +
          "and notes. Supports hard source, state and time filters; an explicit collection is a boundary, not a keyword. Use an empty query plus sources to browse. Use it when a question about the user's projects, activity " +
          "or existing content needs evidence not already supplied. Do not search before clarifying undecided intent or review depth. For notes, results may include a `content` " +
          'preview; use read_knowledge_record to read long notes and transcripts in database-backed pages, ' +
          'following nextCursor until the required coverage is complete. Do not fetch a saved record URL as a ' +
          'substitute for its stored body. Any pasted diagram/screenshot is included there as ' +
          '"[Image: <description>]" using its stored vision analysis — treat that description as what the ' +
          "image actually shows, don't claim you can't see embedded images. Native editable diagrams " +
          'are retrieved separately with search_diagrams and read_diagram.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Topic words only; empty string to browse sources. Do not search generic words such as interesting/log/latest for collection browsing.' },
            sources: { type: 'array', items: { type: 'string' }, description: 'Hard source filters, e.g. discovered-article for Discover, note for Think notes. App dictionary supplies family mappings.' },
            states: { type: 'array', items: { type: 'string', enum: ['to-review', 'saved', 'blog', 'archived', 'published', 'shelved'] }, description: 'Discover workflow states. Default to-review. Only widen when requested.' },
            dateField: { type: 'string', enum: ['published', 'discovered', 'updated'] },
            within: { type: 'object', properties: { period: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } },
              description: 'Either a Europe/London calendar period (today/yesterday/this week/last week/this month/last month), or ISO UTC start/end (end excluded).' },
            projectId: { type: 'string', description: 'Optional project to rank first (e.g. "imagine"). Matches from other projects are still returned, each with its projectId. Omit when looking for something he mentioned (a person, meeting, call, feedback or note) — it is often filed under a different project from the current chat.' },
            limit: { type: 'integer', description: `Max results to return (default ${AI_TOOL_SEARCH_DEFAULT_LIMIT}, max ${AI_TOOL_SEARCH_MAX_LIMIT}).` },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_diagrams',
        description: 'Read saved editable diagrams across projects matching a phrase in their title, shape labels/descriptions, connector labels/descriptions or linked notes. Use for comparisons and cross-diagram reasoning. Returns structured evidence, source project and linked-note excerpts with diagram links. For "the new diagram" or "the diagram we are working on" without a known title/ID, start with an empty query and no projectId to list recent diagrams across projects; do not assume its title or project matches the client note. If keyword searches find nothing, use that recent listing before asking the user to supply a diagram. Not a screenshot analysis or editing tool.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'A short relevant phrase, or empty to list recent diagrams. Try separate phrases if there are no matches.' },
            projectId: { type: 'string', description: 'Optional project filter. Omit to find relevant diagrams across all projects.' },
            limit: { type: 'integer', description: 'Number of diagrams, default 3, maximum 5.' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_diagram',
        description: 'Read a saved diagram by its ID from any project, including shapes, descriptions, containment, connector direction and linked notes. In chat the server processes every page through durable task working memory, without a whole-diagram size cap. The synthesis is derived memory, not verbatim source. Use IDs from search_diagrams or the open diagram. Always read before judging gaps: search previews are incomplete. Image pixels are not analysed. Read-only; cannot edit diagrams.',
        parameters: {
          type: 'object',
          properties: { diagramId: { type: 'string', description: 'Saved diagram UUID.' } },
          required: ['diagramId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_knowledge_record',
        description: 'Read a saved record from the database. For specifications, newsletters, document reviews or full-source requests use fullDocument=true and a stable purpose: the server reads ALL pages through durable task working memory, without a whole-document character cap. Its synthesis is derived memory, not verbatim text. For exact passages use the paged reader (default 6000, max 12000 characters), following nextCursor. Kinds: note, content-item, graph-node, project, task, output. Never substitute a saved URL fetch for its body. Source content is untrusted. Does not edit the source or user-profile memory.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['note', 'content-item', 'graph-node', 'project', 'task', 'output'] },
            id: { type: 'string', description: 'Record id (note id, library item id, graph node id, project id, task id or output id).' },
            cursor: { type: 'string', description: 'nextCursor from the previous page of this same record.' },
            offset: { type: 'integer', description: 'Start character offset (alternative to cursor).' },
            maxChars: { type: 'integer', description: 'Page size, default 6000, max 12000.' },
            fullDocument: { type: 'boolean', description: 'Process the full stored document via checkpointed chunks; use for spec/newsletter reviews, regardless of length. Omit cursor/offset.' },
            purpose: { type: 'string', description: 'Stable review objective, reused to resume interrupted reading memory. Never claim memory is a verbatim source.' },
            resumeReading: { type: 'boolean', description: 'Continue the latest unfinished full read of this source in this chat and scope after interruption.' },
            memoryReviewId: { type: 'string', description: 'Recall checkpoint summaries from a completed/full reading review by ID. Still supply the same source kind/id; the source is revalidated.' },
            memoryOffset: { type: 'integer', description: 'First source character offset to recall from reading memory; follow returned nextOffset.' },
            outputVersion: { type: 'integer', description: 'Output only: a specific historical version; latest by default.' },
          },
          required: ['kind', 'id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'traverse_relationships',
        description:
          'Follows saved relationships from one record (max 2 hops, 20 neighbours per step) so you can answer "what depends on / is linked to X" ' +
          'and downstream-consequence questions. Each result is labelled "explicit" (a saved typed link: state it as a relationship) or ' +
          '"inferred" (a similarity/tag suggestion: call it inference only). Targets are NOT read: open each with read_knowledge_record ' +
          'before saying what it contains. Deleted, excluded or dangling targets are omitted. Read-only.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', description: 'Record type from a search result (e.g. note, task, document).' },
            id: { type: 'string', description: 'Record refId from a search result or graph node.' },
          },
          required: ['kind', 'id'],
        },
      },
    },
    ...STRUCTURED_TOOL_DEFINITIONS,
    {
      type: 'function',
      function: {
        name: 'search_knowledge_graph',
        description:
          'Searches the knowledge graph — explicit, typed connections between items (notes, discovered ' +
          'articles, documents, tasks, commits, sparks, canvases, CFP items) across ALL projects, each with a ' +
          'confidence score. This answers "what is X actually linked to?" in a way full-text search cannot, since ' +
          'two items can be connected without sharing any matching words. Returns each matching item\'s strongest ' +
          'connections (with project), plus "bridges": items linked to several matches, which show how separate ' +
          'work relates. Use it whenever the user asks how things relate/connect, what else bears on a topic, or ' +
          'for implications across projects. Matches titles by phrase or all words, and tags.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'A topic, product, project or item title (e.g. "agent-first platforms", "IMAGINE", "Copilot Studio").' },
            limit: { type: 'integer', description: `Max matching nodes to seed from (default ${AI_TOOL_SEARCH_DEFAULT_LIMIT}, max ${AI_TOOL_SEARCH_MAX_LIMIT}).` },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_tasks',
        description:
          "Lists real tasks from the user's Plan board (Kanban) — the source of truth for outstanding/due/" +
          'overdue work. Use this (not search_knowledge_base) whenever the user asks what tasks, to-dos, or ' +
          'work items they have, are due, are overdue, or outstanding — search_knowledge_base only searches ' +
          "indexed documents/commits/notes, not the task board.",
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: [...TASK_STATUSES], description: 'Filter to a single status. Omit for all non-completed statuses.' },
            dueOnOrBefore: { type: 'string', description: 'ISO date YYYY-MM-DD — only tasks due on or before this date (e.g. today, for "due today or overdue").' },
            overdueOnly: { type: 'boolean', description: 'If true, only tasks with a due date strictly before today that are not completed.' },
            projectId: { type: 'string', description: 'Filter to a specific project id. Omitted defaults to the active conversation project for its task board; an empty string lists tasks across projects.' },
            includeCompleted: { type: 'boolean', description: 'If true, include completed tasks too. Defaults to false.' },
            tag: { type: 'string', description: 'Only tasks with this Plan tag, e.g. "use-case" for the use-case (demo) backlog.' },
            includeBody: { type: 'boolean', description: "If true, include each task's description (trimmed) — e.g. to read a use case's pitch and spec." },
            limit: { type: 'integer', description: `Max results (default ${AI_TOOL_SEARCH_DEFAULT_LIMIT}, max ${AI_TOOL_SEARCH_MAX_LIMIT}).` },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_content_pipeline',
        description:
          "Shows his content plan: when the next podcast recording and newsletter are due, today's content pick from article " +
          'discovery (one topic in one format, with the angle, why now, the coverage check and the link), and what is lined up for ' +
          'the podcast and newsletter. Use it when he asks what to write, record or post next, what today\'s pick is, or about the ' +
          'schedule. Not for general article searches.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_content_plan',
        description:
          "Updates his content plan. Use when he moves a date (\"the newsletter's moved to Monday 12 October\", \"podcast is next Monday\") " +
          'or answers today\'s pick: he is going with it (pickStatus "done") or does not want it (pickStatus "dropped" — it is never ' +
          'suggested again and a new pick is chosen). Dates are YYYY-MM-DD.',
        parameters: {
          type: 'object',
          properties: {
            podcastDate: { type: 'string', description: 'Next podcast recording date, YYYY-MM-DD.' },
            newsletterDate: { type: 'string', description: 'Next newsletter due date, YYYY-MM-DD.' },
            note: { type: 'string', description: 'Optional note about the change, e.g. "depends on workload".' },
            pickStatus: { type: 'string', enum: ['done', 'dropped'], description: "Resolve today's open pick." },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'screenshot_page',
        description:
          'Takes screenshots of a public web page (url) — or of a mock-up saved in this chat (output_id) — at desktop, ' +
          'tablet and/or mobile size, and shows you the pictures so you can judge the actual layout, visual hierarchy, ' +
          'spacing and responsiveness. Use it when he asks you to look at, review or compare a website, or to check a ' +
          'mock-up you made. Captures cover the top of the page (about three screens). The pictures are also added to ' +
          'the chat\'s Screens panel. Public pages only — no logins.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The page to capture, e.g. "https://themicrosoftcloudblog.com".' },
            output_id: { type: 'string', description: 'Instead of a url: an html mock-up output in this chat to render.' },
            devices: { type: 'array', items: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] }, description: 'Defaults to desktop and mobile.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_files',
        description:
          "Lists his files by WHERE they are and WHAT they are — OneDrive files (synced from his OneDrive folders, e.g. " +
          '"Internal", "Imagine", "Reckitt"), uploaded Library files and repo docs — by folder, file type and/or words in ' +
          'the file name. Use this whenever he describes a file rather than its content: "the Excel in the Internal folder", ' +
          '"the deck in my Imagine OneDrive", "Microsoft Help Needed.xlsx", a filename in a screenshot. When exactly one ' +
          'file matches, its extracted content is included.',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Folder name or path, e.g. "Internal" or "Imagine". Matches any folder level.' },
            fileType: { type: 'string', enum: ['excel', 'word', 'powerpoint', 'pdf', 'image', 'drawio', 'markdown', 'any'], description: 'Kind of file. "excel" covers .xlsx/.xls/.csv.' },
            name: { type: 'string', description: 'Words from the file name, e.g. "help needed".' },
            includeContent: { type: 'boolean', description: 'Include each matching file\'s extracted content (trimmed). Always included when only one file matches.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_library',
        description:
          "Searches ONLY the Library section — formal markdown documents (specs, READMEs, docs/ folders) " +
          "stored in the user's GitHub repos, documents synced from the user's OneDrive (IBM Alliance tenant — PRDs, decks, " +
          "spreadsheets, diagrams, with images described), plus uploaded Library files. It does NOT cover notes, the discovery feed, tasks, emails, " +
          "or anything else — those are search_knowledge_base only. Never use this as a substitute for " +
          "search_knowledge_base on a project question; call search_knowledge_base first (or alongside) so " +
          "notes and discovered articles are represented, and use this in addition when the question is " +
          "specifically about formal docs/specs/READMEs. Searches document CONTENT (PRDs, specs, ADRs, design docs) " +
          "and returns the most relevant passage plus the document text for each match.",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search terms — matched against the documents\' full content as well as titles (any term can match; results are ranked). Use the key concepts, not a whole sentence.' },
            projectId: { type: 'string', description: 'Optional project filter (e.g. "imagine"). Omit or use an empty string to search all projects. Shared product/platform documents can inform any client conversation without extra permission.' },
            limit: { type: 'integer', description: `Max results (default ${AI_TOOL_SEARCH_DEFAULT_LIMIT}, max ${AI_TOOL_SEARCH_MAX_LIMIT}).` },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_task',
        description: "Creates a new task on the user's Plan board (Kanban). New tasks land in the Plan Inbox for the user to accept or dismiss; only set another status when the user explicitly asks (e.g. \"I'm working on it now\").",
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short imperative task title.' },
            body: { type: 'string', description: 'Optional longer description / notes for the task.' },
            status: { type: 'string', enum: [...TASK_STATUSES], description: 'Defaults to "inbox" (awaiting the user\'s review). Use "waiting" (with waitingOn) for work blocked on someone or something.' },
            waitingOn: { type: 'string', description: 'Who or what a "waiting" task is waiting on, e.g. "Feedback from Sarah".' },
            priority: { type: 'string', enum: [...TASK_PRIORITIES], description: 'Defaults to "normal".' },
            projectId: { type: 'string', description: 'Project id to file this under (e.g. "personal", "ibm-msft-practice"). Defaults to "personal" if unsure.' },
            dueDate: { type: 'string', description: 'ISO date YYYY-MM-DD, optional.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Plan tags, e.g. ["use-case"] for a use case (demo) in the backlog.' },
            linkThisChat: { type: 'boolean', description: 'If true, links this chat to the task so he can open it from Plan.' },
          },
          required: ['title'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_task',
        description:
          'Updates an existing task. Provide taskId if already known (e.g. returned from a prior ' +
          'create_task/search_knowledge_base call in this conversation); otherwise provide matchTitle — a ' +
          'paraphrase or description is fine, it does not need to be an exact substring of the title. The ' +
          'tool does fuzzy keyword matching, not just literal substring matching. If the result has ' +
          '`ambiguous: true` or `needsConfirmation: true`, do not treat the task as updated — show the ' +
          'candidate(s) to the user and ask them to confirm which one they mean before re-calling with the ' +
          'exact taskId.',
        parameters: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Exact task UUID, if known.' },
            matchTitle: { type: 'string', description: 'Partial, case-insensitive title to find the task by, if taskId is not known.' },
            title: { type: 'string', description: 'New title.' },
            body: { type: 'string', description: 'New body/description.' },
            status: { type: 'string', enum: [...TASK_STATUSES], description: '"waiting" replaces the old blocked / awaiting-feedback states — set waitingOn too.' },
            waitingOn: { type: 'string', description: 'Who or what the task is waiting on (for status "waiting"); empty string clears it.' },
            priority: { type: 'string', enum: [...TASK_PRIORITIES] },
            dueDate: { type: 'string', description: 'ISO date YYYY-MM-DD, or null to clear it.' },
            appendBody: { type: 'string', description: 'Text to add to the end of the description (keeps what is there).' },
            specFromOutputId: { type: 'string', description: "Id of an Output in this chat: its latest version goes into the task description under a '## Spec' heading, replacing any earlier Spec section and keeping the rest." },
            tags: { type: 'array', items: { type: 'string' }, description: "Replaces the task's Plan tags." },
            linkThisChat: { type: 'boolean', description: 'If true, links this chat to the task.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'remember',
        description:
          "Saves a STANDING INSTRUCTION that Athena follows in all future conversations. Call it whenever Richard " +
          "states a lasting preference or correction — e.g. 'from now on…', 'always…', 'never…', 'remember that…', " +
          "'blog posts should include…', 'in future…'. Do NOT call it for one-off requests about the current reply. " +
          "Write the instruction as a short, self-contained imperative (e.g. 'Include the source URL at the end of " +
          "every blog post package'). Choose the narrowest correct scope. After saving, confirm in one short line " +
          "starting 'Remembered:' — do not repeat it at length. If the scope is genuinely unclear, ask instead.",
        parameters: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: 'The standing instruction, imperative and self-contained.' },
            scope: {
              type: 'string',
              enum: ['global', 'persona', 'project', 'output'],
              description: "'global' = everywhere; 'persona' = one persona (general, brainstorming, copilot_coach, blog_post, demo_designer, podcast_prep, podcast_show_notes, web_designer); " +
                "'project' = one project id; 'output' = one kind of output (e.g. 'blog post', 'newsletter', 'task summary', 'meeting notes').",
            },
            scopeValue: { type: 'string', description: "Persona id, project id, or output type. Omit for 'global'." },
          },
          required: ['instruction', 'scope'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_output',
        description: 'Reads the latest version of one output in THIS chat, including user edits. Use its output_id from the Outputs index. Read before describing or revising it. Returns a bounded page, version and nextOffset; continue with that version as expected_version before rewriting the whole output.',
        parameters: {
          type: 'object',
          properties: {
            output_id: { type: 'string' },
            offset: { type: 'integer', minimum: 0, description: 'Start at 0; use nextOffset to continue.' },
            expected_version: { type: 'integer', minimum: 1, description: 'Required for subsequent pages: the version returned by the first page. If it changed, start again at offset 0.' },
          },
          required: ['output_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_today_schedule',
        description: 'Reads today\'s recorded personal and pasted IBM meetings, with current UK date/time. Use for questions about today\'s diary, availability, clashes or meeting preparation. The calendar is not loaded automatically; do not infer availability from missing context.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_output',
        description:
          "Saves a DELIVERABLE to this chat's Outputs panel, where Richard can read, copy, edit and version it. Use it " +
          "whenever you produce or revise something he will copy or reuse — a GHCP (GitHub Copilot) prompt, a demo spec, " +
          "user stories, a screen list, a demo script, a CMS package, a draft document — instead of pasting the whole thing " +
          "into your reply. Pass the FULL content every time. To revise an existing output, pass its output_id (listed " +
          "under 'Outputs in this chat') to save a new version; omit it to create a new output. Then keep your reply short: " +
          "say what you produced or changed, in a few lines — the panel shows the full text. This is part of the chat, not " +
          "saving elsewhere, so it needs no permission. Not for short answers, explanations or opinions.",
        parameters: {
          type: 'object',
          properties: {
            output_id: { type: 'string', description: 'Existing output to add a version to. Omit for a new output.' },
            title: { type: 'string', description: 'Short name, e.g. "GHCP prompt — decision queue state changes". Required for a new output.' },
            kind: { type: 'string', enum: ['prompt', 'spec', 'stories', 'screens', 'script', 'document', 'mockup'] },
            format: {
              type: 'string',
              enum: ['markdown', 'text', 'html'],
              description: "'text' for a prompt or anything pasted elsewhere verbatim (shown as one copyable block); 'html' for a " +
                "visual mock-up (kind 'mockup'), shown rendered at desktop/tablet/mobile widths; 'markdown' otherwise.",
            },
            content: {
              type: 'string',
              description: 'The complete deliverable. For an html mock-up: ONE complete, self-contained page starting with ' +
                '<!doctype html> — styles in a <style> tag (or Tailwind via <script src="https://cdn.tailwindcss.com"></script>), ' +
                'responsive, realistic invented content, placeholder images as CSS shapes/gradients or inline SVG, no other external files.',
            },
            change_note: { type: 'string', description: 'For a revision: what changed, in one line.' },
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'propose_map_changes',
        description:
          "Proposes changes to the canvas open next to this chat (outline under 'Canvas in view'). A canvas is a set of " +
          "cards (Think notes, documents, meetings, chats, and Richard's own ideas) joined by typed connections. Use it " +
          "whenever Richard asks you to add ideas, pull related content onto the canvas, connect/link cards, change a " +
          "connection's type, annotate, rename or remove cards. Refer to cards by their alias exactly as in the outline " +
          "(c1, c2 …). To put notes, documents, meetings or chats on the canvas, first find them with search_library or " +
          "search_knowledge_base, then use add_content with content_id = the item's id from the search result — never " +
          "represent a found item as an add_idea card. add_idea is only for Richard's own new ideas. Give new cards a " +
          "'key' (e.g. k1) to connect later changes to them. Connection types: related, " +
          "supports, contradicts, depends on, part of, leads to, example of (or a short custom type). The changes are " +
          "shown as a preview with Apply/Discard — after calling it, reply in one or two short lines; don't repeat them.",
        parameters: {
          type: 'object',
          properties: {
            changes: {
              type: 'array',
              description: 'Changes, applied in order.',
              items: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    enum: ['add_idea', 'add_content', 'connect', 'retype', 'disconnect', 'annotate', 'rename', 'remove'],
                    description: 'add_idea = new idea card; add_content = put a found note/document/meeting/chat on the canvas; ' +
                      'connect = link two cards; retype = change the type of the connection between from and to; ' +
                      'disconnect = remove that connection; annotate = set a card\'s note; rename = change a card\'s title; remove = delete a card.',
                  },
                  card: { type: 'string', description: 'annotate/rename/remove: the card alias.' },
                  connect_to: { type: 'string', description: 'add_idea/add_content: alias or key of the card to connect the new card to.' },
                  from: { type: 'string', description: 'connect/retype/disconnect: alias or key of one card.' },
                  to: { type: 'string', description: 'connect/retype/disconnect: alias or key of the other card.' },
                  type: { type: 'string', description: 'Connection type for connect/retype/add_*, e.g. "supports".' },
                  content_id: { type: 'string', description: 'add_content: the id of the item from a search result.' },
                  label: { type: 'string', description: 'add_idea/rename: card title; connect: optional connection label.' },
                  note: { type: 'string', description: 'add_idea/add_content/annotate: the card\'s note (why it matters here).' },
                  key: { type: 'string', description: 'add_*: your own key for the new card so later changes can refer to it.' },
                  summary: { type: 'string', description: 'One short line describing this change.' },
                },
                required: ['action', 'summary'],
              },
            },
          },
          required: ['changes'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'propose_note_edit',
        description:
          "Proposes changes to the Think note that is open next to this chat (shown under 'Document in view'). " +
          "Use it whenever Richard asks you to add to, write into, update, rewrite, restructure, tidy, fix or remove " +
          "content in the open note. The edits are shown to him as a preview with Apply/Discard — they are not saved " +
          "until he applies them. You cannot click Apply for him: if he asks to apply an existing preview, explain " +
          "that he must use its Apply button rather than proposing the same edits again. " +
          "For repairs or consolidation, replace the contradictory content rather than appending overrides or a plan " +
          "instead of the requested finished content. Check that promised records, tables and references actually " +
          "exist in the proposed Markdown. Tool acceptance verifies edit targets, not semantic completeness or a saved result. " +
          "Reference headings EXACTLY as they appear in the note. Write content as Markdown " +
          "(headings, lists, checklists '- [ ]', tables). A SMALL request gets the smallest edit that does the job " +
          "(add_to_section or replace_text). Review, update, proofread and wording clean-up mean exact replace_text edits, preserving " +
          "all existing formatting, lists, links, images and heading levels. The markdown field for replace_text is plain replacement text, " +
          "not a newly formatted paragraph. Do not turn a request to fix your previous mistake into permission for a clean rewrite. " +
          "Body edits never rename the note: retain its existing title heading, even during an authorised redraft. " +
          "But when he explicitly asks for a whole-note or many-section change — rewrite, redraft, expand " +
          "every section, restructure, turn it into a fuller spec — do ALL of it in this turn: never change one section and offer " +
          "to do the rest later, and never ask permission to continue. BIG changes: write them section by section (one edit per section, each " +
          "under about 1,200 words). A very long rewrite can be several propose_note_edit calls in the same turn — each adds to " +
          "the same preview — so never try to fit more than about 2,500 words in one call (it gets cut off). Use replace_all only " +
          "for a complete redraft. If the tool returns an error, fix it and call again; do not tell him you have proposed " +
          "anything until the tool says it was proposed. After it succeeds, reply in one or two short lines saying what " +
          "you've proposed and that he can review and Apply it — do not paste the content again in your reply.",
        parameters: {
          type: 'object',
          properties: {
            edits: {
              type: 'array',
              description: 'One or more edits, applied in order.',
              items: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    enum: ['append', 'prepend', 'add_to_section', 'replace_section', 'delete_section', 'replace_text', 'replace_all'],
                    description: "append = end of note; prepend = top (after the title); add_to_section = end of the section under 'heading'; " +
                      "replace_section = replace the content under 'heading'; delete_section = remove 'heading' and its content; " +
                      "replace_text = replace the exact existing text 'find' with 'markdown'; replace_all = rewrite the WHOLE note " +
                      "with 'markdown' — use this for a full redraft or rewrite instead of many separate edits.",
                  },
                  heading: { type: 'string', description: 'Exact heading text of the target section (section actions only).' },
                  find: { type: 'string', description: 'Exact existing text to replace (replace_text only) — a sentence or phrase copied from the note.' },
                  markdown: { type: 'string', description: 'New content as Markdown. For section actions, give ONLY the section body — do not repeat the heading line (it stays in the note). To ADD a new section (append/prepend/add_to_section), start with a real Markdown heading, e.g. "## Summary". Use a blank line between paragraphs.' },
                  summary: { type: 'string', description: 'One short line describing this edit, e.g. "Add a Summary section at the top".' },
                },
                required: ['action', 'summary'],
              },
            },
          },
          required: ['edits'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_memories',
        description: "Lists Athena's active standing instructions (with ids). Use when Richard asks what Athena remembers, or before forgetting one.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'forget_memory',
        description: "Removes a standing instruction by id (get ids from list_memories). Use when Richard says to stop doing something Athena was told to remember.",
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Memory id from list_memories.' } },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_spark',
        description:
          'Saves a brief thought or idea as a Spark when the user asks to capture it. ' +
          'Use this instead of creating a Think note or Plan task for Spark requests. ' +
          'Creates a standalone Spark unless the user asks to attach it to a known source. ' +
          'Do not invent source IDs or save Sparks without the user asking.',
        parameters: {
          type: 'object',
          properties: {
            body: { type: 'string', description: 'The thought to capture. Preserve the user\'s meaning and wording.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag names, not tag IDs.' },
            sourceId: { type: 'string', description: 'Optional source ID from the user or a tool result; requires sourceType.' },
            sourceType: { type: 'string', description: 'The source type paired with sourceId (e.g. discover_item or note).' },
          },
          required: ['body'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_note_draft',
        description: 'Creates a new document draft in the Think section (notes).',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Title of the note/document.' },
            content: {
              type: 'string',
              description:
                'The draft content as plain text or simple markdown. A blank line separates paragraphs; ' +
                'lines starting with #, ## or ### become headings.',
            },
            contentType: { type: 'string', enum: [...NOTE_CONTENT_TYPES], description: 'Defaults to "note".' },
            projectId: {
              type: 'string',
              description:
                'Project id to file this under: the project the material most directly serves (e.g. "imagine" for anything ' +
                'about the IMAGINE platform or agent platforms it relies on), taken from the project catalogue. Set it ' +
                'whenever you can tell. If omitted, the active project is used, else the best-fitting live project is ' +
                'inferred, falling back to "ibm-thought-leadership" for general article drafts.',
            },
          },
          required: ['title', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fetch_web_page',
        description:
          'Fetches and reads the text content of a single external web page by URL — for grounding a claim, ' +
          'a competitor product, an article, or any external source outside the knowledge hub. Use this ' +
          "(especially in the brainstorming persona) instead of answering from memory when the user references " +
          'a specific URL, or when a concrete external fact would materially change the critique. Does not ' +
          'perform a web search — it can only read a page whose exact URL you already have (from the user\'s ' +
          'message or a prior tool result); it cannot discover new URLs.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full http(s) URL of the page to fetch.' },
          },
          required: ['url'],
        },
      },
    },
    // Microsoft Learn MCP tools (microsoft_docs_search, microsoft_docs_fetch,
    // microsoft_code_sample_search as of writing) — fetched live from the
    // remote MCP server so we track whatever it currently advertises rather
    // than hardcoding a schema that may drift. Empty array (not an error) if
    // the server is unreachable this turn.
    ...getAssetToolDefinitions(),
    ...learnTools,
    // Tavily MCP tools (tavily-search, tavily-extract as of writing) — real
    // internet search/page extraction, distinct from fetch_web_page (which
    // can only read a URL already known). Empty array if TAVILY_API_KEY is
    // unset or the server is unreachable this turn.
    ...tavilyTools,
  ];
}

/** The open note's saved BlockNote blocks (for checking proposed edits), or null if unavailable. */
async function loadNoteBlocks(db: Pool, noteId: string): Promise<Array<Record<string, unknown>> | null> {
  try {
    const { rows } = await db.query<{ content: unknown }>(`SELECT content FROM notes WHERE id::text = $1`, [noteId]);
    let content = rows[0]?.content;
    if (typeof content === 'string') content = JSON.parse(content);
    let blocks = (content as { contentJson?: unknown } | undefined)?.contentJson;
    if (typeof blocks === 'string') blocks = JSON.parse(blocks);
    return Array.isArray(blocks) ? blocks as Array<Record<string, unknown>> : null;
  } catch {
    return null;
  }
}

/** Dispatches a single tool call by name, returning a JSON-serialisable result. */
export async function executeToolCall(
  db: Pool,
  name: string,
  argsJson: string,
  activeProjectId?: string,
  turn: {
    sessionId?: string | undefined; noteId?: string | undefined; designOwner?: string | undefined; designState?: DesignTurnState; noteEdits?: NoteEditProposal[];
    allowStructuralNoteEdits?: boolean | undefined;
    retrievalScope?: RetrievalScope | undefined; retrievalAudit?: RetrievalAudit | undefined;
    excludedIds?: ReadonlySet<string>;
    /** Exclusions could not be loaded: retrieval tools fail closed. Strict "only project X" scope is server-derived. */
    exclusionsFailed?: boolean; strictProjectId?: string | null; signal?: AbortSignal | undefined;
    /** Open mind map: outline alias (n1 …) → idea id, and a collector for proposed changes. */
    mapAliases?: Map<string, string> | undefined; mapCanvas?: CanvasFull | undefined; mapChanges?: MapChangeProposal[];
    /** Folders on his PC (Athena Desktop) and a collector for proposed file writes. */
    localFolders?: LocalFolder[]; localFileWrites?: LocalFileWriteProposal[];
  } = {},
): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return {
      error: 'Malformed tool arguments — could not parse JSON.' + (name === 'propose_note_edit'
        ? ' The call was most likely cut off because it was too long. Split it: send the edits one section at a time, each in its own propose_note_edit call (under about 1,200 words each).'
        : ''),
    };
  }
  // Project defaults apply to filing and task-board context, not knowledge access.
  const contextualArgs =
    args['projectId'] === undefined && activeProjectId !== undefined && activeProjectId.trim() !== ''
      ? { ...args, projectId: activeProjectId }
      : args;
  if (name === 'manage_scheduled_jobs') return executeJobTool(db, args, turn.sessionId);
  if (name === 'manage_publishing_feeds') return executePublishingTool(db, args, turn.sessionId);
  if (AGENT_TOOL_NAMES.has(name)) return executeAgentTool(db, name, args, turn);

  if (turn.exclusionsFailed === true && EXCLUSION_GATED_TOOLS.has(name)) return EXCLUSIONS_UNAVAILABLE_RESULT;
  if (name === 'read_design_package' || name === 'save_design_documents') {
    if (isOutsideCollectionTool(name, turn.retrievalScope)) return { error: 'Design operations are outside this request’s enforced collection scope.', code: 'scope_mismatch' };
    if (!turn.designOwner) return { error: 'Open the Design in Think before working with its package.' };
    try { return await executeDesignTool(db, name, turn.designOwner, args, turn, turn.designState); }
    catch (error) {
      console.error('[Design chat] Package operation failed:', error);
      return { error: error instanceof Error ? error.message : 'Design operation failed. No completion has been confirmed.' };
    }
  }
  if (turn.designOwner && ['create_note_draft', 'propose_note_edit', 'update_note', 'create_demo_specification', 'save_output'].includes(name)) {
    return { error: 'This is a Design conversation. Use read_design_package and save_design_documents to update or create the section in this Design. Do not create a disconnected note.' };
  }
  if (isOutsideCollectionTool(name, turn.retrievalScope)) {
    if (turn.retrievalAudit !== undefined) turn.retrievalAudit.blockedCalls++;
    return { error: 'This tool is outside the user’s requested collection. Use search_knowledge_base within the supplied source/date/state scope.', code: 'scope_mismatch' };
  }
  if ((name === 'read_knowledge_record' || name === 'fetch_web_page') && turn.retrievalScope?.filter.sources !== undefined) {
    const values: unknown[] = [name === 'fetch_web_page' ? args['url'] : args['id']];
    const where = searchFilterSql(turn.retrievalScope.filter, values);
    const { rows } = await db.query(
      `SELECT ci.id FROM content_items ci WHERE ${name === 'fetch_web_page' ? 'ci.url = $1' : '(ci.id::text = $1 OR ci.source_id = $1)'} AND ${where} LIMIT 1`, values);
    if (rows.length === 0) {
      if (turn.retrievalAudit !== undefined) turn.retrievalAudit.blockedCalls++;
      return { error: 'Record is outside the requested source, time or state boundary, or is unavailable. Do not read a different collection as a substitute.', code: 'scope_mismatch' };
    }
  }
  if (name === 'read_knowledge_record') return executeReadKnowledgeRecord(db, args, turn);
  if (name === 'traverse_relationships') {
    if (!isKnowledgeOrchestrationEnabled()) return { error: 'Relationship traversal is not enabled.' };
    if (turn.exclusionsFailed === true) return EXCLUSIONS_UNAVAILABLE_RESULT;
    return executeTraverseRelationships(db, args, { excludedIds: turn.excludedIds, signal: turn.signal });
  }
  if (STRUCTURED_TOOL_NAMES.has(name)) {
    if (!isKnowledgeOrchestrationEnabled()) return { error: 'Structured task and change queries are not enabled.' };
    if (turn.exclusionsFailed === true) return EXCLUSIONS_UNAVAILABLE_RESULT;
    return executeStructuredTool(db, name, args, { sessionId: turn.sessionId, strictProjectId: turn.strictProjectId, signal: turn.signal });
  }

  if (isAssetTool(name)) return executeAssetTool(db, name, contextualArgs, turn.noteId);
  if (LOCAL_FILE_TOOL_NAMES.has(name)) return executeLocalFileTool(db, name, args, turn.localFolders ?? [], turn.localFileWrites);

  switch (name) {
    case 'get_demo_specification_template': return demoSpecificationForm();
    case 'create_demo_specification': {
      const sourceId = args['sourceNoteId'];
      if (typeof sourceId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceId)) return { error: 'Provide the actual source Think note UUID.' };
      if (!turn.sessionId) return { error: 'A saved chat is required for demo specification provenance.' };
      if (turn.exclusionsFailed || turn.excludedIds?.has(sourceId)) return { error: 'Source note is unavailable or excluded from this conversation.' };
      const source = await db.query<{ project_id: string | null }>(
        `SELECT project_id FROM notes WHERE id = $1 AND status = 'active'`, [sourceId],
      );
      if (!source.rows[0]) return { error: 'Source Think note was not found or is not active. No specification saved.' };
      if (turn.strictProjectId && source.rows[0].project_id !== turn.strictProjectId) return { error: 'Source Think note is outside this conversation\'s strict project scope. No specification saved.' };
      let draft: ReturnType<typeof renderDemoSpecification>;
      try {
        draft = renderDemoSpecification(args, {
          noteUrl: `${env.FRONTEND_BASE_URL}/think?noteId=${encodeURIComponent(sourceId)}`,
          chatUrl: `${env.FRONTEND_BASE_URL}/chat?session=${encodeURIComponent(turn.sessionId)}`,
        });
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Invalid demo specification fields.', saved: false };
      }
      const note = await createNoteRecord(db, {
        content: JSON.stringify({ title: draft.title, contentType: 'spec', contentJson: JSON.stringify(textToBlocks(draft.markdown)) }),
        tags: ['spec', 'use-case'],
        ...(source.rows[0].project_id ? { projectId: source.rows[0].project_id } : {}),
      });
      return {
        success: true,
        note: { id: note.id, title: draft.title, url: `${env.FRONTEND_BASE_URL}/think?noteId=${note.id}` },
        sourceNoteId: sourceId,
        message: 'Created a new Think specification with all template fields. Source note unchanged. This draft is not approval or evidence of completed work.',
      };
    }
    case 'get_discover_sources': return getDiscoverSources(db);
    case 'get_discover_watchlist_records': return retrieveWatchlistRecords(db, args);
    case 'inspect_discover_feed': {
      const url = args['feedUrl'];
      if (typeof url !== 'string' || url.trim() === '') return { error: 'Provide a public RSS/Atom feed URL.' };
      return inspectDiscoverFeed(db, url.trim());
    }
    case 'search_past_chats': {
      const query = args['query'];
      if (typeof query !== 'string' || query.trim() === '') return { error: 'Provide a few words from the earlier conversation.' };
      const limit = typeof args['limit'] === 'number' && Number.isFinite(args['limit'])
        ? Math.min(Math.max(Math.round(args['limit']), 1), PAST_CHAT_SEARCH_MAX_LIMIT) : PAST_CHAT_SEARCH_DEFAULT_LIMIT;
      const chats = await searchPastChats(db, query, turn.sessionId, limit);
      return chats.length === 0
        ? { chats: [], note: 'No saved chat matched. Try different or fewer distinctive words before telling the user it does not exist.' }
        : { chats, note: 'Links open the chat in Athena on any device. Use read_past_chat to read one before summarising it.' };
    }
    case 'read_past_chat': {
      const id = args['sessionId'];
      if (typeof id !== 'string' || id.trim() === '') return { error: 'Provide a sessionId from search_past_chats.' };
      const query = typeof args['query'] === 'string' ? args['query'].trim() : undefined;
      const chat = await readPastChat(db, id.trim(), PAST_CHAT_READ_DEFAULT_MESSAGES, query);
      return chat === null ? { error: 'No saved chat with that id.' } : { ...chat, href: `/chat?session=${encodeURIComponent(id.trim())}` };
    }
    case 'get_project_details': {
      const id = contextualArgs['projectId'];
      if (typeof id !== 'string' || id.trim() === '') return { error: 'Provide a saved project ID from the projects catalog.' };
      const project = await loadCurrentProjectContext(db, id.trim());
      return project === null
        ? { error: `Project "${id}" was not found.` }
        : { project, note: 'Current saved Projects record, read now. Takes precedence over older chat history and memories.' };
    }
    // With a canvas open, searches are usually for picking items to put on it — short extracts are enough.
    case 'search_knowledge_base': return searchKnowledgeBase(db, args, turn.mapCanvas !== undefined ? CANVAS_SEARCH_CONTENT_CHARS : undefined, turn);
    case 'search_knowledge_graph': return searchKnowledgeGraph(db, args);
    case 'search_diagrams':
    case 'read_diagram': {
      const diagramId = args['diagramId'];
      if (name === 'read_diagram' && (typeof diagramId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(diagramId))) {
        return { error: 'Provide a saved diagram UUID from search_diagrams or the open diagram.' };
      }
      if (name === 'search_diagrams' && typeof args['query'] !== 'string') {
        return { error: 'Provide a search phrase, or an empty query to list recent diagrams.' };
      }
      if (name === 'read_diagram' && typeof diagramId === 'string' && args['fullDocument'] === true) {
        if (turn.sessionId === undefined) return { error: 'A chat session is required for a checkpointed diagram read.' };
        return readDiagramPage(db, { diagramId, sessionId: turn.sessionId, cursor: args['cursor'],
          ...(turn.excludedIds !== undefined && { excludedIds: turn.excludedIds }) });
      }
      const projectId = name === 'search_diagrams' ? args['projectId'] : undefined;
      const result = await findDiagramContext(db, {
        ...(name === 'read_diagram' && typeof diagramId === 'string' ? { diagramId } : {}),
        ...(name === 'search_diagrams' && typeof args['query'] === 'string' ? { query: args['query'] } : {}),
        ...(typeof projectId === 'string' && projectId.trim() !== '' ? { projectId } : {}),
        ...(typeof args['limit'] === 'number' && Number.isFinite(args['limit']) ? { limit: args['limit'] } : {}),
        ...(turn.excludedIds !== undefined ? { excludedIds: turn.excludedIds } : {}),
      });
      if (name === 'read_diagram') return result.results.length === 0
        ? { error: 'Saved diagram not found or excluded from this conversation.' } : result;
      return { ...result, results: result.results.map(item => ({ ...item,
        content: item.content.slice(0, DIAGRAM_SEARCH_PREVIEW_CHARS), preview: true })),
        note: 'Discovery previews only; read_diagram processes the complete saved diagram before comparison or review.' };
    }
    case 'list_tasks':            return listTasks(db, contextualArgs);
    case REVIEW_DECISIONS_TOOL:   return executeReviewDecisions(db, contextualArgs, turn);
    case 'find_files':            return findFiles(db, args);
    case 'screenshot_page':       return screenshotPage(db, args, turn.sessionId);
    case 'get_content_pipeline': {
      const { chooseDailyPick, describePipeline } = await import('./contentPick.js');
      return { pipeline: describePipeline(await chooseDailyPick(db)) };
    }
    case 'set_content_plan': {
      const { setScheduleDate, getSchedule, describeSchedule } = await import('./contentSchedule.js');
      const { resolveOpenPick } = await import('./contentPick.js');
      const done: string[] = [];
      const note = typeof args['note'] === 'string' ? args['note'] : undefined;
      try {
        if (typeof args['podcastDate'] === 'string') { await setScheduleDate(db, 'podcast', args['podcastDate'], note); done.push(`podcast set to ${args['podcastDate']}`); }
        if (typeof args['newsletterDate'] === 'string') { await setScheduleDate(db, 'newsletter', args['newsletterDate'], note); done.push(`newsletter set to ${args['newsletterDate']}`); }
      } catch (err) { return { error: err instanceof Error ? err.message : 'Could not set the date.' }; }
      if (args['pickStatus'] === 'done' || args['pickStatus'] === 'dropped') {
        const closed = await resolveOpenPick(db, args['pickStatus']);
        done.push(closed === null ? 'there was no open pick' : `pick "${closed.title}" marked ${args['pickStatus']}`);
      }
      if (done.length === 0) return { error: 'Nothing to change: give a podcastDate, newsletterDate or pickStatus.' };
      return { updated: done, schedule: describeSchedule(await getSchedule(db)) };
    }
    case 'search_library':        return searchLibrary(db, args, turn.mapCanvas !== undefined ? CANVAS_SEARCH_CONTENT_CHARS : LIBRARY_RESULT_CONTENT_CHARS);
    case 'create_task':           return createTask(db, args, turn.sessionId);
    case 'update_task':           return updateTask(db, args, turn.sessionId);
    case 'create_note_draft':     return createNoteDraft(db, contextualArgs);
    case 'create_spark':          return createSparkFromChat(db, args);
    case 'remember':              return rememberInstruction(db, args, turn.sessionId);
    case 'get_today_schedule': return { schedule: await buildTodayScheduleBlock(db) };
    case 'read_output': {
      if (turn.sessionId === undefined) return { error: 'No chat to read an output from.' };
      const id = args['output_id'];
      const offset = args['offset'] ?? 0;
      const expectedVersion = args['expected_version'];
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return { error: 'Provide an output_id from this chat\'s Outputs index.' };
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return { error: 'offset must be a non-negative safe integer.' };
      if (expectedVersion !== undefined && (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
        return { error: 'expected_version must be a positive safe integer.' };
      }
      if (offset > 0 && expectedVersion === undefined) return { error: 'Provide expected_version from the first page before continuing.' };
      const output = await readOutputForChat(db, turn.sessionId, id, offset, expectedVersion);
      return output === null ? { error: 'That output was not found in this chat.' } : output;
    }
    case 'save_output': {
      if (turn.sessionId === undefined) return { error: 'No chat to save the output in.' };
      if (typeof args['content'] !== 'string' || args['content'].trim() === '') return { error: 'content is required.' };
      try {
        const saved = await saveOutputVersion(db, turn.sessionId, {
          outputId: typeof args['output_id'] === 'string' && args['output_id'] !== '' ? args['output_id'] : undefined,
          title: typeof args['title'] === 'string' ? args['title'] : undefined,
          kind: typeof args['kind'] === 'string' ? args['kind'] : undefined,
          format: typeof args['format'] === 'string' ? args['format'] : undefined,
          content: args['content'],
          author: 'athena',
          note: typeof args['change_note'] === 'string' ? args['change_note'] : undefined,
        });
        return { saved: true, output_id: saved.id, title: saved.title, version: saved.version, note: 'Shown in the Outputs panel. Reply briefly with what you produced or changed.' };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Could not save the output.' };
      }
    }
    case 'propose_note_edit': {
      if (turn.noteId === undefined || turn.noteId === '' || turn.noteId.startsWith('doc:') || turn.noteId.startsWith('map:')) {
        return { error: 'No editable Think note is open next to this chat. Library documents are read-only.' };
      }
      const { edits, problems } = validateNoteEdits(args['edits']);
      if (problems.length > 0) return { error: `No edits proposed: ${problems.join('; ')}. Correct the whole edit batch and retry.` };
      if (edits.length === 0) return { error: `No valid edits: ${problems.join('; ') || 'edits array was empty'}` };
      if (turn.allowStructuralNoteEdits === false && edits.some(edit => edit.action !== 'replace_text')) {
        return { error: 'No edits proposed. This is a wording/review correction, not permission to rewrite or reformat the note. Use unique exact replace_text edits with plain replacement text. Preserve headings, title, rich formatting, links, lists, images and all untouched content.' };
      }
      // Check every edit against the note as saved, so Apply can't fail on a heading or phrase that isn't there.
      const blocks = await loadNoteBlocks(db, turn.noteId);
      if (blocks !== null) {
        const prior = turn.noteEdits ?? [];
        const mismatches = checkEditsAgainstNote([...prior, ...edits], blocks, prior.length);
        if (mismatches.length > 0) {
          return {
            error: `Not proposed — these edits don't match the note: ${mismatches.join('; ')}. Call propose_note_edit again ` +
              'using the exact headings below and copying unique "find" text exactly from one paragraph. Do not switch to a full rewrite to bypass a target mismatch.',
            headingsInNote: noteHeadings(blocks),
          };
        }
      }
      turn.noteEdits?.push(...edits);
      return { proposed: edits.length, ...(problems.length > 0 && { skipped: problems }), note: 'Shown to the user as a preview with Apply/Discard.' };
    }
    case 'propose_map_changes': {
      if (turn.mapCanvas !== undefined && turn.mapCanvas.canvasType !== 'brainstorm') {
        return { error: 'The open canvas is a diagram, not a brainstorm canvas: propose_map_changes cannot change it. Use update_diagram with the diagram id instead.' };
      }
      if (turn.mapAliases === undefined || turn.mapCanvas === undefined) return { error: 'No canvas is open next to this chat.' };
      const { proposals, problems } = await resolveMapChanges(db, args['changes'], turn.mapCanvas, turn.mapAliases);
      if (proposals.length === 0) return { error: `No valid changes: ${problems.join('; ') || 'changes array was empty'}` };
      turn.mapChanges?.push(...proposals);
      return { proposed: proposals.length, ...(problems.length > 0 && { skipped: problems }), note: 'Shown to the user as a preview with Apply/Discard.' };
    }
    case 'list_memories':         return { memories: (await listMemories(db)).filter((m) => m.kind === 'instruction' && m.status === 'active').map((m) => ({ id: m.id, instruction: m.content, scope: m.scopeType, scopeValue: m.scopeValue })) };
    case 'forget_memory': {
      const id = typeof args['id'] === 'string' ? args['id'] : '';
      if (id === '') return { error: 'id required' };
      await deleteMemory(db, id);
      return { forgotten: id };
    }
    case 'fetch_web_page':        return fetchWebPage(args);
    case 'search_ica':            return searchIca(args);
    default:
      if (isLearnMcpTool(name)) return callLearnMcpTool(name, args);
      if (isTavilyMcpTool(name)) return callTavilyMcpTool(name, args);
      return { error: `Unknown tool: ${name}` };
  }
}

// ── search_knowledge_base ───────────────────────────────────────────────────

/**
 * Resolves the ranked item set for search_knowledge_base. Combines two
 * sources rather than preferring one exclusively:
 *   - Postgres FTS (getRagItems) — covers everything in content_items,
 *     including notes/tasks-adjacent content, which is NOT indexed into
 *     Foundry IQ (only uploaded documents go through foundryIqIndexer.ts).
 *   - Foundry IQ (Azure AI Search agentic/semantic retrieval) — catches
 *     paraphrased/semantically-related documents that literal FTS keyword
 *     matching structurally cannot (e.g. a question about "approved LLM
 *     list" won't lexically match a note that says "model governance
 *     constraints").
 * Previously Foundry IQ results, when present, were returned exclusively —
 * which silently dropped any FTS-only matches (i.e. all notes) whenever
 * Foundry IQ found even one loosely-relevant document. Merging avoids that:
 * FTS results are listed first (higher precision, direct term match), then
 * topped up with any additional Foundry IQ matches not already present.
 */
export async function getKnowledgeBaseItems(db: Pool, query: string, limit: number, projectId = ''): Promise<Awaited<ReturnType<typeof getRagItems>>> {
  // A project filter ranks that project first but never hides real matches
  // elsewhere: what he refers to is often filed under another client (e.g.
  // feedback from an IMAGINE meeting discussed in an IKEA chat).
  const [scoped, everywhere] = await Promise.all([
    projectId === '' ? Promise.resolve([]) : getRagItems(db, query, limit, projectId),
    getRagItems(db, query, limit),
  ]);
  const directMatches = projectId === '' ? everywhere : interleaveUnique(everywhere, scoped);
  let combined = directMatches;

  if (isFoundryIqEnabled()) {
    try {
      const ids = await retrieveContentItemIds(query, projectId === '' ? limit : Math.max(limit * FOUNDRY_PROJECT_OVERFETCH, FOUNDRY_MIN_FETCH));
      if (ids.length > 0) {
        const items = await getContentItemsByIds(db, ids);
        const filtered = projectId === '' ? items : items.filter((item) => item.projectContext === projectId);
        const seen = new Set(combined.map((item) => item.id));
        combined = [...combined, ...filtered.filter((item) => !seen.has(item.id))];
      }
    } catch (err) {
      console.error('Foundry IQ retrieval failed, continuing with Postgres FTS results only:', err);
    }
  }

  if (projectId === '' || combined.length >= Math.min(MIN_DIRECT_MATCHES, limit)) return combined.slice(0, limit);

  const overviewItems = await getProjectContextItems(db, projectId, limit);
  const seen = new Set(combined.map((item) => item.id));
  return [
    ...combined,
    ...overviewItems.filter((item) => !seen.has(item.id)),
  ].slice(0, limit);
}

export function interleaveUnique<T extends { id: string }>(first: T[], second: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    for (const item of [first[i], second[i]]) {
      if (item !== undefined && !seen.has(item.id)) { seen.add(item.id); out.push(item); }
    }
  }
  return out;
}

/**
 * For a project-scoped search: documents in OTHER projects whose title matches
 * the query, so a file he names that is filed elsewhere is reported (with where
 * it is) instead of being missed or swapped for a different document.
 */
async function matchesInOtherProjects(db: Pool, projectId: string, query: string): Promise<Record<string, unknown>> {
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])
    .flatMap((t) => t.replace(/[-_]+/g, ' ')    .split(' ')).filter((t) => t.length >= MIN_TERM_CHARS))];
  if (terms.length === 0) return {};
  const { rows } = await db.query<{ title: string; project: string; path: string | null }>(
    `SELECT COALESCE(NULLIF(ci.title, ''), 'Untitled Document') AS title, COALESCE(p.name, ci.project_context, 'personal') AS project,
            COALESCE(ci.metadata->>'path', ci.metadata->>'filename') AS path
       FROM content_items ci LEFT JOIN projects p ON p.id = ci.project_context
      WHERE ci.source IN ('github-doc', 'github-content-store', 'user-upload', 'onedrive-document')
        AND ${canonicalContentSql('ci')}
        AND ci.project_context IS DISTINCT FROM $1
        AND to_tsvector('english', coalesce(ci.title, '') || ' ' || coalesce(ci.metadata->>'filename', '')) @@ to_tsquery('english', $2)
      ORDER BY ts_rank_cd(to_tsvector('english', coalesce(ci.title, '')), to_tsquery('english', $2)) DESC, ci.updated_at DESC
      LIMIT 5`,
    [projectId, terms.join(' | ')],
  );
  if (rows.length === 0) return {};
  return {
    inOtherProjects: rows.map((r) => ({ title: r.title, project: r.project, path: r.path ?? '' })),
    otherProjectsNote: 'These documents match by title but are filed in OTHER projects, so this project-scoped search did not ' +
      'include them. If relevant to the question, search their project or omit the project filter and read them. ' +
      'No extra permission is needed to use relevant knowledge across projects. Identify their source project; ' +
      'never substitute a different document from this project for a named document.',
  };
}

async function searchKnowledgeBase(db: Pool, args: Record<string, unknown>, contentChars?: number, turn: {
  sessionId?: string | undefined; retrievalScope?: RetrievalScope | undefined; retrievalAudit?: RetrievalAudit | undefined;
  excludedIds?: ReadonlySet<string>; strictProjectId?: string | null; signal?: AbortSignal | undefined;
} = {}): Promise<unknown> {
  let query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  let filter;
  try { filter = resolveSearchFilter(args, turn.retrievalScope); }
  catch (error) {
    if (error instanceof RetrievalScopeError || error instanceof Error && error.name === 'IntervalError') return { status: 'invalid_request', error: error.message };
    throw error;
  }
  const scopedSources = turn.retrievalScope?.filter.sources;
  if (scopedSources !== undefined) {
    if (Array.isArray(args['sources']) && args['sources'].some(source => !scopedSources.includes(String(source)))) {
      if (turn.retrievalAudit !== undefined) turn.retrievalAudit.blockedCalls++;
    }
    if (query.toLowerCase().replace(/\b(?:any|anything|interesting|items?|articles?|in|the|discover(?:y)?|logs?|lists?|feeds?|latest|recent|new|what|is|s)\b/g, '').replace(/[\s?'.-]/g, '') === '') query = '';
  }
  if (query === '' && filter.sources === undefined) return { error: 'A query or explicit sources for browsing is required.' };
  const rawLimit = Number(args['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), AI_TOOL_SEARCH_MAX_LIMIT)
    : AI_TOOL_SEARCH_DEFAULT_LIMIT;
  const projectId = typeof args['projectId'] === 'string' ? args['projectId'].trim() : '';

  const search = await searchKnowledge(
    { query, limit, filter, ...(projectId !== '' && { projectId }), ...(turn.signal !== undefined && { signal: turn.signal }) },
    createDbSearchBackends({
      db, filter, ...(turn.sessionId !== undefined && { turnId: turn.sessionId }),
      ...(turn.excludedIds !== undefined && { excludedIds: turn.excludedIds }),
      ...(turn.strictProjectId !== undefined && { strictProjectId: turn.strictProjectId }),
      ...(isFoundryIqEnabled() && { retrieveIds: (q: string, n: number, signal: AbortSignal): Promise<string[]> => retrieveContentItemIds(q, n, signal) }),
    }),
  );
  // Both backends failing is an outage, never "no results".
  if (search.status === 'unavailable') {
    return { error: 'Knowledge search is temporarily unavailable. Do not conclude that nothing exists.', status: 'unavailable', issues: search.issues };
  }
  const items = search.hits.map((hit) => ({
    ...hit.record, projectContext: hit.record.projectContext,
    hit,
  }));
  const results = await Promise.all(items.map(async ({ hit, ...item }) => ({
    // Lets Athena put the item on a canvas (propose_map_changes add_content).
    id: item.id,
    source: item.source,
    title: item.title,
    summary: item.summary,
    projectId: item.projectContext,
    version: hit.version,
    matchKind: hit.matchKind,
    extractionStatus: hit.extractionStatus,
    snippet: hit.snippet,
    readRef: hit.readRef,
    ...(hit.duplicates.length > 0 && { duplicates: hit.duplicates }),
    // Include note/image text rather than summary alone. Orchestration caps search
    // previews so the source budget remains available for explicit record reads.
    ...(item.source === 'note' && { content: searchContentPreview(await buildNoteContentForAI(db, item.body), contentChars) }),
    ...(item.source === 'ica-document' && { content: searchContentPreview(item.body) }),
    ...(item.source === 'user-upload' && { content: searchContentPreview(item.body) }),
    publishedAt: item.publishedAt,
    indexedAt: item.indexedAt,
    discoveredAt: typeof item.metadata['discoveredAt'] === 'string' ? item.metadata['discoveredAt'] : null,
    publicationDateKnown: item.metadata['publicationDateKnown'] ?? null,
    ...(item.state !== undefined && { state: item.state }),
    // For PRs/issues/MRs/pipelines/deployments this is when the item was
    // created, not when it was last worked on — metadata.updatedAt (surfaced
    // below as lastActivityAt) is the source's own last-touched timestamp
    // and is what "what's new"/"recent activity" questions should use.
    lastActivityAt: (item.metadata as { updatedAt?: string } | null)?.updatedAt ?? item.publishedAt,
    url: item.url ?? null,
  })));

  if (turn.retrievalAudit !== undefined) for (const item of results) {
    turn.retrievalAudit.resultSources[item.source] = (turn.retrievalAudit.resultSources[item.source] ?? 0) + 1;
  }
  const elsewhere = projectId !== '' && filter.sources === undefined ? await matchesInOtherProjects(db, projectId, query) : {};
  return {
    resultCount: results.length, results, ...elsewhere,
    appliedScope: { ...filter, ...(turn.retrievalScope !== undefined && { families: turn.retrievalScope.families, inherited: turn.retrievalScope.inherited, timeDefaulted: turn.retrievalScope.timeDefaulted }) },
    note: 'Bounded search/browse sample, not exhaustive or the exact Discover UI ranking. No matches does not permit widening source, state or dates. indexedAt is not first discovery; unknown publication provenance is not proof of newly published news.',
    coverage: { status: search.status, issues: search.issues },
    ...(search.disambiguation !== undefined && { disambiguation: search.disambiguation }),
  };
}

// ── search_knowledge_graph ───────────────────────────────────────────────────

async function searchKnowledgeGraph(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (query === '') return { error: 'query is required' };
  const rawLimit = Number(args['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), AI_TOOL_SEARCH_MAX_LIMIT)
    : AI_TOOL_SEARCH_DEFAULT_LIMIT;
  return searchGraph(db, query, limit);
}

/**
 * Renders a note's stored content as plain text for the model, replacing each
 * embedded image block with its stored GPT-4V vision analysis so Athena
 * actually knows what a pasted diagram/screenshot shows.
 *
 * Note that `content_items.body` for notes now holds already-rendered text
 * rather than the original wrapper JSON, which `renderNoteAsText` passes
 * through unchanged.
 */
async function buildNoteContentForAI(db: Pool, rawContentJson: string): Promise<string> {
  const text = await renderNoteAsText(db, rawContentJson);
  return text.length > NOTE_CONTENT_MAX_CHARS ? `${text.slice(0, NOTE_CONTENT_MAX_CHARS)}…` : text;
}

// ── list_tasks ────────────────────────────────────────────────────────────────

async function listTasks(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const conditions: string[] = ['archived = false'];
  const params: unknown[] = [];

  const includeCompleted = args['includeCompleted'] === true;
  const overdueOnly = args['overdueOnly'] === true;

  const statusFilter = normaliseTaskStatus(args['status']);
  if (statusFilter !== undefined) {
    params.push(statusFilter);
    conditions.push(`status = $${params.length}`);
  } else if (!includeCompleted) {
    conditions.push(`status != 'completed'`);
  }

  if (typeof args['projectId'] === 'string' && args['projectId'].trim() !== '') {
    params.push(args['projectId'].trim());
    conditions.push(`project_id = $${params.length}`);
  }

  if (typeof args['tag'] === 'string' && args['tag'].trim() !== '') {
    params.push(args['tag'].trim());
    conditions.push(`id IN (SELECT tt.task_id FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
                            WHERE g.slug = lower(regexp_replace($${params.length}, '\\s+', '-', 'g')) OR lower(g.name) = lower($${params.length}))`);
  }

  if (overdueOnly) {
    conditions.push(`due_date IS NOT NULL AND due_date < CURRENT_DATE`);
  } else if (typeof args['dueOnOrBefore'] === 'string' && args['dueOnOrBefore'].trim() !== '') {
    params.push(args['dueOnOrBefore'].trim());
    conditions.push(`due_date IS NOT NULL AND due_date <= $${params.length}`);
  }

  const rawLimit = Number(args['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), AI_TOOL_SEARCH_MAX_LIMIT)
    : AI_TOOL_SEARCH_DEFAULT_LIMIT;
  params.push(limit);

  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY due_date ASC NULLS LAST, created_at DESC LIMIT $${params.length}`,
    params,
  );

  const tasks = result.rows.map(rowToTask);
  const tagNames = await taskTagNames(db, tasks.map((t) => t.id));
  const includeBody = args['includeBody'] === true;
  return {
    resultCount: tasks.length,
    tasks: tasks.map((t) => ({
      ...summariseTask(t),
      tags: tagNames.get(t.id) ?? [],
      ...(includeBody && { body: t.body.length > TASK_BODY_CHARS ? `${t.body.slice(0, TASK_BODY_CHARS)}…` : t.body }),
    })),
  };
}

// ── screenshot_page ─────────────────────────────────────────────────────────

/**
 * Pictures to show the model after this round of tool calls. A tool result
 * can carry `__images` (data URLs with labels); the conversation loop takes
 * them out of the text result and adds them as a picture message.
 */
export interface ToolImages { __images?: Array<{ label: string; url: string }> }

async function screenshotPage(db: Pool, args: Record<string, unknown>, sessionId: string | undefined): Promise<unknown> {
  if (!isScreenshotServiceConfigured()) return { error: 'Screenshots are not available (the screenshot service is not configured).' };
  const devices = (Array.isArray(args['devices']) ? args['devices'] : ['desktop', 'mobile'])
    .filter((d): d is ShotDevice => d === 'desktop' || d === 'tablet' || d === 'mobile').slice(0, MAX_SCREENSHOT_DEVICES);
  const outputId = typeof args['output_id'] === 'string' ? args['output_id'].trim() : '';
  let url = typeof args['url'] === 'string' ? args['url'].trim() : '';
  let html: string | undefined;
  let label = url;
  if (outputId !== '') {
    const output = /^[0-9a-f-]{36}$/i.test(outputId) ? await getOutput(db, outputId) : null;
    if (output === null || output.sessionId !== sessionId || output.format !== 'html') return { error: 'No html mock-up with that output_id in this chat.' };
    html = output.versions[output.versions.length - 1]!.content;
    label = `${output.title} (v${output.versions.length.toString()})`;
  } else {
    if (url === '') return { error: 'Give a url or an output_id.' };
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    label = url;
  }
  try {
    const shot = await takeScreenshots({ ...(html !== undefined ? { html } : { url }), devices: devices.length > 0 ? devices : ['desktop', 'mobile'], fullPage: true });
    const name = html !== undefined ? label : (shot.title !== '' ? shot.title : new URL(shot.finalUrl || url).hostname);
    if (sessionId !== undefined) {
      for (const img of shot.images) {
        await addScreenUnread(db, sessionId, { buffer: Buffer.from(img.base64, 'base64'), contentType: img.mimeType, name: `${name} — ${img.device}`.slice(0, SCREEN_NAME_CHARS) })
          .catch((err: unknown) => { console.warn('[screenshot] could not add to Screens:', err); });
      }
    }
    const result: Record<string, unknown> & ToolImages = {
      captured: shot.images.map((i) => `${i.device} (${i.width.toString()}px wide, top ${i.height.toString()}px of the page)`),
      title: shot.title,
      ...(html === undefined && { finalUrl: shot.finalUrl }),
      note: 'The screenshots are attached for you to look at now, and added to the chat\'s Screens panel. Judge the layout from the pictures.',
      __images: shot.images.map((i) => ({ label: `${name} — ${i.device}`, url: `data:${i.mimeType};base64,${i.base64}` })),
    };
    return result;
  } catch (err) {
    return { error: `Could not capture ${label}: ${err instanceof Error ? err.message : String(err)}. Tell him plainly; don't describe the page from memory.` };
  }
}

// ── find_files ──────────────────────────────────────────────────────────────

const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  excel: ['xlsx', 'xls', 'xlsm', 'csv'],
  word: ['docx', 'doc'],
  powerpoint: ['pptx', 'ppt'],
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  drawio: ['drawio'],
  markdown: ['md', 'markdown'],
};
const FIND_FILES_LIMIT = 25;
const FIND_FILES_CONTENT_CHARS = 8_000;
const FOUNDRY_PROJECT_OVERFETCH = 5;
const FOUNDRY_MIN_FETCH = 40;
const MIN_DIRECT_MATCHES = 3;
const MIN_TERM_CHARS = 3;
const MIN_SHORT_TERM_CHARS = 2;
const MAX_SCREENSHOT_DEVICES = 3;
const SCREEN_NAME_CHARS = 120;
const ISO_DATE_CHARS = 10;
const CONFIDENT_MATCH_SCORE = 0.5;
const CONFIDENT_MATCH_MARGIN = 0.25;
const PLAUSIBLE_MATCH_SCORE = 0.34;
const MAX_AMBIGUOUS_CANDIDATES = 5;
const MAX_TASK_TAGS = 10;
const STRONG_PROJECT_FIT = 2;

/** find_files — his files by folder, type and name (OneDrive, uploads, repo docs), with content for a single match. */
async function findFiles(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const folder = typeof args['folder'] === 'string' ? args['folder'].trim().replace(/^\/+|\/+$/g, '') : '';
  const fileType = typeof args['fileType'] === 'string' ? args['fileType'] : 'any';
  const nameWords = typeof args['name'] === 'string'
    ? args['name'].toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_SHORT_TERM_CHARS)
    : [];
  const params: unknown[] = [];
  const where = [`ci.source IN ('onedrive-document', 'user-upload', 'github-doc', 'github-content-store')`, canonicalContentSql('ci')];
  const pathExpr = `lower(COALESCE(ci.metadata->>'path', ci.metadata->>'filename', ci.title, ''))`;
  if (folder !== '') {
    params.push(folder.toLowerCase());
    where.push(`(${pathExpr} LIKE $${params.length.toString()} || '/%' OR ${pathExpr} LIKE '%/' || $${params.length.toString()} || '/%')`);
  }
  const exts = FILE_TYPE_EXTENSIONS[fileType];
  if (exts !== undefined) {
    params.push(exts);
    where.push(`(lower(COALESCE(ci.metadata->>'fileType', '')) = ANY($${params.length.toString()}) OR substring(${pathExpr} from '\\.([a-z0-9]+)$') = ANY($${params.length.toString()}))`);
  }
  for (const w of nameWords) {
    params.push(`%${w}%`);
    where.push(`(lower(COALESCE(ci.title, '')) LIKE $${params.length.toString()} OR ${pathExpr} LIKE $${params.length.toString()})`);
  }
  params.push(FIND_FILES_LIMIT);
  const { rows } = await db.query<{ id: string; title: string; source: string; path: string | null; project: string | null; url: string | null; updated_at: Date; body: string | null }>(
    `SELECT ci.id::text, COALESCE(NULLIF(ci.title, ''), 'Untitled') AS title, ci.source,
            COALESCE(ci.metadata->>'path', ci.metadata->>'filename') AS path, COALESCE(p.name, ci.project_context) AS project,
            ci.url, ci.updated_at, ci.body
       FROM content_items ci LEFT JOIN projects p ON p.id = ci.project_context
      WHERE ${where.join(' AND ')}
      ORDER BY ci.updated_at DESC
      LIMIT $${params.length.toString()}`,
    params,
  );
  const withContent = rows.length === 1 || args['includeContent'] === true;
  const files = rows.map((r) => ({
    id: r.id,
    title: r.title,
    where: r.source === 'onedrive-document' ? `OneDrive: ${r.path ?? r.title}` : r.source === 'user-upload' ? `Uploaded: ${r.path ?? r.title}` : `Repo doc: ${r.path ?? r.title}`,
    project: r.project ?? 'personal',
    modified: r.updated_at.toISOString().slice(0, ISO_DATE_CHARS),
    url: r.url ?? '',
    ...(withContent && { content: (r.body ?? '').slice(0, FIND_FILES_CONTENT_CHARS) }),
  }));
  return {
    resultCount: files.length,
    files,
    ...(files.length === 0 && {
      hint: 'No file matched. Tell him plainly that you cannot find it (and what you looked for) — do not offer a different file as if it were the one he means. OneDrive files appear here after the hourly sync.',
    }),
  };
}

// ── search_library ──────────────────────────────────────────────────────────

// Library content per result. Enough for the model to reason over a PRD or
// design doc section, bounded so several results fit comfortably in context.
const LIBRARY_RESULT_CONTENT_CHARS = 6_000;
/** Search result text per item when a canvas is open (enough to choose what to add; the canvas reads it in full). */
const CANVAS_SEARCH_CONTENT_CHARS = 1_200;

/**
 * search_library — searches every Library document (project repo docs, the
 * content store, uploaded files) by CONTENT, using the indexed stored copies.
 *
 * Previously this re-listed repos live from GitHub on every call (slow, and a
 * repo GitHub refused just vanished), matched only titles/paths for repo docs,
 * and matched the whole query as one exact substring — so multi-word questions
 * found nothing even when PRDs and design docs clearly covered them.
 */
async function searchLibrary(db: Pool, args: Record<string, unknown>, contentChars = LIBRARY_RESULT_CONTENT_CHARS): Promise<unknown> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  const projectId = typeof args['projectId'] === 'string' ? args['projectId'].trim() : '';
  const rawLimit = Number(args['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), AI_TOOL_SEARCH_MAX_LIMIT)
    : AI_TOOL_SEARCH_DEFAULT_LIMIT;

  if (projectId !== '') {
    const p = await db.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (p.rowCount === 0) return { error: `No project found with id "${projectId}"` };
  }

  // Any-word match, ranked: documents matching more (and rarer) terms, and
  // matching in the title, come first. Words are reduced to safe tokens.
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])
    .map((t) => t.replace(/[-_]+/g, ' ').trim())
    .flatMap((t) => t.split(' '))
    .filter((t) => t.length >= MIN_SHORT_TERM_CHARS))];
  const orQuery = terms.join(' | ');

  const params: unknown[] = [];
  const where = [`ci.source IN ('github-doc', 'github-content-store', 'user-upload', 'onedrive-document')`, canonicalContentSql('ci')];
  if (projectId !== '') {
    params.push(projectId);
    where.push(`ci.project_context = $${params.length}`);
  }
  let rankSql = '0';
  let headlineSql = `left(coalesce(ci.body, ''), 400)`;
  if (orQuery !== '') {
    params.push(orQuery);
    const tsq = `to_tsquery('english', $${params.length})`;
    where.push(`ci.search_vector @@ ${tsq}`);
    rankSql = `ts_rank_cd(ci.search_vector, ${tsq}, 32)`;
    headlineSql = `ts_headline('english', coalesce(ci.body, ''), ${tsq},
      'MaxFragments=3, MinWords=12, MaxWords=40, FragmentDelimiter=" … ", StartSel="", StopSel=""')`;
  }
  params.push(limit);

  const rows = await db.query<{
    id: string;
    source: string;
    title: string;
    url: string | null;
    project_name: string | null;
    project_context: string | null;
    metadata: Record<string, unknown> | null;
    body: string | null;
    excerpt: string;
    rank: number;
  }>(
    `SELECT ci.id::text, ci.source, COALESCE(NULLIF(ci.title, ''), 'Untitled Document') AS title, ci.url,
            p.name AS project_name, ci.project_context, ci.metadata, ci.body,
            ${headlineSql} AS excerpt,
            ${rankSql} AS rank
       FROM content_items ci
       LEFT JOIN projects p ON p.id = ci.project_context
      WHERE ${where.join(' AND ')}
      ORDER BY rank DESC, ci.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );

  const documents = rows.rows.map((r) => {
    const repo = typeof r.metadata?.['repo'] === 'string'
      ? r.metadata['repo']
      : r.source === 'user-upload' ? 'Uploaded Library' : r.source === 'onedrive-document' ? 'OneDrive' : '';
    const path = typeof r.metadata?.['path'] === 'string'
      ? r.metadata['path']
      : (typeof r.metadata?.['filename'] === 'string' ? r.metadata['filename'] : r.title);
    return {
      id: r.id,
      title: r.title,
      project: r.project_name ?? r.project_context ?? 'personal',
      repo: repo === CONTENT_STORE ? 'Content Store' : repo,
      path,
      url: r.url ?? '',
      excerpt: r.excerpt,
      content: searchContentPreview(r.body ?? '', contentChars),
    };
  });

  const elsewhere = projectId !== '' ? await matchesInOtherProjects(db, projectId, query) : {};
  return {
    resultCount: documents.length,
    matchedTerms: terms,
    documents,
    ...elsewhere,
    ...(documents.length === 0 && {
      hint: projectId !== ''
        ? 'No Library documents matched in this project. Try broader or different terms, or search without the project filter.'
        : 'No Library documents matched. Try broader or different terms.',
    }),
  };
}

// ── remember (standing instructions) ────────────────────────────────────────

async function rememberInstruction(db: Pool, args: Record<string, unknown>, sessionId: string | undefined): Promise<unknown> {
  const instruction = typeof args['instruction'] === 'string' ? args['instruction'].trim() : '';
  if (instruction === '') return { error: 'instruction required' };
  const scopeRaw = typeof args['scope'] === 'string' ? args['scope'] : 'global';
  const scope = (['global', 'persona', 'project', 'output'] as const).find((s) => s === scopeRaw) ?? 'global';
  const scopeValue = typeof args['scopeValue'] === 'string' ? args['scopeValue'].trim() : '';
  if (scope !== 'global' && scopeValue === '') return { error: `scopeValue required for scope "${scope}"` };
  const memory = await createMemory(db, {
    content: instruction,
    scopeType: scope,
    scopeValue: scope === 'global' ? null : scopeValue,
    origin: 'chat',
    sourceSessionId: sessionId ?? null,
  });
  return { saved: true, id: memory.id, instruction: memory.content, scope: memory.scopeType, scopeValue: memory.scopeValue };
}

// ── create_task / update_task ────────────────────────────────────────────────

function summariseTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.waitingOn !== null && { waitingOn: task.waitingOn }),
    priority: task.priority,
    projectId: task.projectId,
    dueDate: task.dueDate,
    // Deep link back into the Plan board — lets chat replies point at the
    // actual task in the app instead of just naming it in plain text.
    url: `${env.FRONTEND_BASE_URL}/plan?taskId=${task.id}`,
  };
}

async function createTask(db: Pool, args: Record<string, unknown>, sessionId: string | undefined): Promise<unknown> {
  const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
  if (title === '') return { error: 'title is required' };

  // Athena's tasks go to the Inbox for review unless he asked for a specific working state.
  const requestedStatus = normaliseTaskStatus(args['status']);
  const status = requestedStatus === undefined || requestedStatus === 'backlog' ? 'inbox' : requestedStatus;
  const waitingOn = status === 'waiting' && typeof args['waitingOn'] === 'string' && args['waitingOn'].trim() !== '' ? args['waitingOn'].trim() : null;
  const priority = TASK_PRIORITIES.includes(args['priority'] as typeof TASK_PRIORITIES[number]) ? args['priority'] as string : 'normal';
  const projectId = typeof args['projectId'] === 'string' && args['projectId'].trim() !== '' ? args['projectId'].trim() : 'personal';
  const body = typeof args['body'] === 'string' ? args['body'] : '';
  const dueDate = typeof args['dueDate'] === 'string' && args['dueDate'].trim() !== '' ? args['dueDate'].trim() : null;

  // First guard: if an active task with the same title already exists in the
  // same project, reuse it instead of creating a second open copy.
  const openDupe = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks
     WHERE archived = false
       AND status <> 'completed'
       AND project_id = $1
       AND lower(title) = lower($2)
     ORDER BY updated_at DESC
     LIMIT 1`,
    [projectId, title],
  );
  const openDupeRow = openDupe.rows[0];
  if (openDupeRow !== undefined) {
    return { success: true, task: summariseTask(rowToTask(openDupeRow)), duplicate: true };
  }

  // Second guard: catches immediate accidental replays (e.g. duplicate tool
  // call in the same chat turn) even when the first row was completed quickly.
  const recentDupe = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks
     WHERE archived = false
       AND project_id = $1
       AND lower(title) = lower($2)
       AND created_at > now() - interval '5 minutes'
     ORDER BY created_at DESC
     LIMIT 1`,
    [projectId, title],
  );
  const recentDupeRow = recentDupe.rows[0];
  if (recentDupeRow !== undefined) {
    return { success: true, task: summariseTask(rowToTask(recentDupeRow)), duplicate: true };
  }

  // Third guard: the same action already exists in any state (done, archived,
  // other project) — report it rather than adding it to the Plan again.
  const anyDupe = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE lower(title) = lower($1) ORDER BY updated_at DESC LIMIT 1`,
    [title],
  );
  const anyDupeRow = anyDupe.rows[0];
  if (anyDupeRow !== undefined) {
    return {
      success: true,
      task: summariseTask(rowToTask(anyDupeRow)),
      duplicate: true,
      note: `Not added — this task already exists (status: ${String(anyDupeRow['status'])}${anyDupeRow['archived'] === true ? ', archived' : ''}). Tell the user rather than creating another.`,
    };
  }

  const result = await db.query<Record<string, unknown>>(
    `INSERT INTO tasks (title, body, status, project_id, tags, priority, due_date, waiting_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [title, body, status, projectId, [], priority, dueDate, waitingOn],
  );
  const row = result.rows[0];
  if (row === undefined) return { error: 'Insert returned no rows' };

  const task = rowToTask(row);
  queueAutoTag(db, 'task', task.id);
  const tags = Array.isArray(args['tags']) ? await setTaskTags(db, task.id, args['tags']) : [];
  const linkedChat = args['linkThisChat'] === true && sessionId !== undefined ? await linkChat(db, task.id, sessionId) : false;
  return { success: true, task: { ...summariseTask(task), tags }, ...(linkedChat && { linkedChat: true }) };
}

// Common English filler words to strip when tokenizing a matchTitle for fuzzy
// keyword matching — keeps the signal on the words that actually identify
// the task (names, subjects) rather than connective words every title has.
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'and', 'or', 'of', 'with', 'on', 'in', 'at', 'is', 'are',
  'we', 'i', 've', 'have', 'has', 'got', 'please', 'set', 'up', 'set up', 'that', 'this',
  'task', 'organise', 'organize', 'arrange', 'schedule', 'about', 'our', 'the', 'move', 'mark',
]);

function tokenizeTitle(text: string): string[] {
  return Array.from(new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .map((w) => w.replace(/^'|'s$|'$/g, ''))
      .filter((w) => w.length >= MIN_TERM_CHARS && !TITLE_STOPWORDS.has(w)),
  ));
}

async function resolveTask(
  db: Pool,
  taskId: unknown,
  matchTitle: unknown,
): Promise<
  | { id: string; title: string }
  | { ambiguous: Array<{ id: string; title: string }> }
  | { suggested: { id: string; title: string } }
  | { notFound: true }
  | { error: string }
> {
  if (typeof taskId === 'string' && taskId.trim() !== '') {
    const r = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE id = $1 AND archived = false`,
      [taskId.trim()],
    );
    const row = r.rows[0];
    return row !== undefined ? row : { notFound: true };
  }
  if (typeof matchTitle === 'string' && matchTitle.trim() !== '') {
    const trimmed = matchTitle.trim();
    const r = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE archived = false AND title ILIKE $1 ORDER BY created_at DESC LIMIT 5`,
      [`%${trimmed}%`],
    );
    if (r.rows.length === 1) return r.rows[0] as { id: string; title: string };
    if (r.rows.length > 1) return { ambiguous: r.rows };

    // No literal substring match — fall back to fuzzy keyword-overlap matching
    // so a paraphrase like "organise a meeting with Kyle Thompson" can still
    // find "Speak to Kyle's EA and set up meeting on Project Imagine...".
    const keywords = tokenizeTitle(trimmed);
    if (keywords.length === 0) return { notFound: true };

    const orConditions = keywords.map((_, i) => `title ILIKE $${i + 1}`).join(' OR ');
    const params = keywords.map((kw) => `%${kw}%`);
    const fuzzy = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE archived = false AND (${orConditions}) ORDER BY created_at DESC LIMIT 20`,
      params,
    );
    if (fuzzy.rows.length === 0) return { notFound: true };

    const scored = fuzzy.rows
      .map((row) => {
        const titleLower = row.title.toLowerCase();
        const matched = keywords.filter((kw) => titleLower.includes(kw)).length;
        return { row, score: matched / keywords.length };
      })
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best === undefined) return { notFound: true };

    // All keywords present — confident enough to resolve outright.
    if (best.score === 1) return best.row;

    const runnerUp = scored[1];
    // Best candidate matched most keywords and clearly beats the next one —
    // still surface it for confirmation rather than silently updating the
    // wrong task, but as a single suggestion rather than a raw "not found".
    if (best.score >= CONFIDENT_MATCH_SCORE && (runnerUp === undefined || best.score - runnerUp.score >= CONFIDENT_MATCH_MARGIN)) {
      return { suggested: best.row };
    }

    // Multiple plausible candidates within the same ballpark — let the user pick.
    const topCandidates = scored.filter((s) => s.score >= PLAUSIBLE_MATCH_SCORE).slice(0, MAX_AMBIGUOUS_CANDIDATES).map((s) => s.row);
    if (topCandidates.length > 0) return { ambiguous: topCandidates };

    return { notFound: true };
  }
  return { error: 'Provide either taskId or matchTitle' };
}

async function updateTask(db: Pool, args: Record<string, unknown>, sessionId: string | undefined): Promise<unknown> {
  const resolved = await resolveTask(db, args['taskId'], args['matchTitle']);
  if ('error' in resolved) return resolved;
  if ('notFound' in resolved) {
    return {
      error: 'No matching task found — this may be worded very differently from any task title. ' +
        'Ask the user for more detail (a keyword, project, or the exact title) rather than giving up silently.',
    };
  }
  if ('ambiguous' in resolved) {
    return {
      ambiguous: true,
      message: 'Multiple tasks matched — ask the user which one they mean, or re-call with the exact taskId.',
      candidates: resolved.ambiguous,
    };
  }
  if ('suggested' in resolved) {
    return {
      needsConfirmation: true,
      message:
        `Found a likely match — "${resolved.suggested.title}" — but the wording didn't match closely enough ` +
        'to update it automatically. Ask the user to confirm this is the right task before re-calling with ' +
        'its exact taskId.',
      candidate: resolved.suggested,
    };
  }


  const fields: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown): void => { params.push(val); fields.push(`${col} = $${params.length}`); };

  if (typeof args['title'] === 'string' && args['title'].trim() !== '') add('title', args['title'].trim());
  if (typeof args['body'] === 'string') add('body', args['body']);
  const nextStatus = normaliseTaskStatus(args['status']);
  if (nextStatus !== undefined) add('status', nextStatus);
  if (typeof args['waitingOn'] === 'string') add('waiting_on', args['waitingOn'].trim() || null);
  if (TASK_PRIORITIES.includes(args['priority'] as typeof TASK_PRIORITIES[number])) add('priority', args['priority']);
  if ('dueDate' in args) add('due_date', args['dueDate'] === null ? null : (typeof args['dueDate'] === 'string' ? args['dueDate'] : null));

  // Description changes that build on what's there: an appended note, or a spec from Outputs.
  const appendBody = typeof args['appendBody'] === 'string' ? args['appendBody'].trim() : '';
  const specOutputId = typeof args['specFromOutputId'] === 'string' ? args['specFromOutputId'].trim() : '';
  let specTitle: string | null = null;
  if (appendBody !== '' || specOutputId !== '') {
    let body = typeof args['body'] === 'string'
      ? args['body']
      : ((await db.query<{ body: string | null }>(`SELECT body FROM tasks WHERE id = $1`, [resolved.id])).rows[0]?.body ?? '');
    if (specOutputId !== '') {
      const output = /^[0-9a-f-]{36}$/i.test(specOutputId) ? await getOutput(db, specOutputId) : null;
      if (output === null || output.sessionId !== sessionId) return { error: 'No Output with that id in this chat — check the Outputs list and use its id.' };
      const latest = output.versions[output.versions.length - 1];
      if (latest === undefined) return { error: 'That Output has no content yet.' };
      specTitle = `${output.title} (v${latest.version.toString()})`;
      body = withSpecSection(body, output.title, latest.version, latest.content);
    }
    if (appendBody !== '') {
      // Notes go above the Spec section, so replacing the spec later keeps them.
      const spec = /^## Spec\b/m.exec(body);
      const head = (spec === null ? body : body.slice(0, spec.index)).trimEnd();
      const tail = spec === null ? '' : `\n\n${body.slice(spec.index)}`;
      body = `${head === '' ? appendBody : `${head}\n\n${appendBody}`}${tail}`;
    }
    if (typeof args['body'] === 'string') params[fields.findIndex((f) => f.startsWith('body ='))] = body;
    else add('body', body);
  }

  const wantsTags = Array.isArray(args['tags']);
  const wantsLink = args['linkThisChat'] === true && sessionId !== undefined;
  if (fields.length === 0 && !wantsTags && !wantsLink) return { error: 'No fields to update were provided.' };

  fields.push('updated_at = NOW()');
  params.push(resolved.id);
  const result = await db.query<Record<string, unknown>>(
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  const row = result.rows[0];
  if (row === undefined) return { error: 'Update returned no rows' };

  const task = rowToTask(row);
  const tags = wantsTags ? await setTaskTags(db, task.id, args['tags'] as unknown[]) : (await taskTagNames(db, [task.id])).get(task.id) ?? [];
  const linkedChat = wantsLink ? await linkChat(db, task.id, sessionId) : false;
  return {
    success: true,
    task: { ...summariseTask(task), tags },
    ...(specTitle !== null && { specAdded: specTitle }),
    ...(linkedChat && { linkedChat: true }),
  };
}

// ── Plan task helpers: tags, chat links, spec section ──────────────────────────

const TASK_BODY_CHARS = 1_500;

async function taskTagNames(db: Pool, taskIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (taskIds.length === 0) return map;
  const { rows } = await db.query<{ task_id: string; name: string }>(
    `SELECT tt.task_id::text, g.name FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id::text = ANY($1) ORDER BY g.name`,
    [taskIds],
  );
  for (const r of rows) map.set(r.task_id, [...(map.get(r.task_id) ?? []), r.name]);
  return map;
}

/** Sets a task's Plan tags by name (existing tags matched by name or slug; missing ones created as top-level filing tags). */
async function setTaskTags(db: Pool, taskId: string, raw: unknown[]): Promise<string[]> {
  const names = [...new Set(raw.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TASK_TAGS);
  const ids: string[] = [];
  const out: string[] = [];
  for (const name of names) {
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (slug === '') continue;
    const found = await db.query<{ id: string; name: string }>(
      `SELECT id::text, name FROM tags WHERE slug = $1 OR lower(name) = lower($2) ORDER BY (slug = $1) DESC LIMIT 1`,
      [slug, name],
    );
    const tag = found.rows[0] ?? (await db.query<{ id: string; name: string }>(
      `INSERT INTO tags (name, slug, role) VALUES ($1, $2, 'filing')
       ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id::text, name`,
      [name, slug],
    )).rows[0];
    if (tag === undefined) continue;
    ids.push(tag.id);
    out.push(tag.name);
  }
  await db.query(`DELETE FROM task_tags WHERE task_id = $1`, [taskId]);
  if (ids.length > 0) {
    await db.query(`INSERT INTO task_tags (task_id, tag_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [taskId, ids]);
  }
  return out;
}

/** Links this chat to a task (shown under Linked items in Plan; opens the chat). */
async function linkChat(db: Pool, taskId: string, sessionId: string): Promise<boolean> {
  const { rows } = await db.query<{ title: string | null }>(`SELECT title FROM ai_chat_sessions WHERE id = $1`, [sessionId]);
  const title = rows[0]?.title ?? 'Athena chat';
  await db.query(
    `INSERT INTO task_links (task_id, target_type, target_id, target_title, target_url)
     VALUES ($1, 'chat', $2, $3, $4)
     ON CONFLICT (task_id, target_type, target_id) DO UPDATE SET target_title = EXCLUDED.target_title`,
    [taskId, sessionId, title, `/chat?session=${encodeURIComponent(sessionId)}`],
  );
  return true;
}

/** Puts a spec under a '## Spec' heading at the end of the description, replacing an earlier one. */
function withSpecSection(body: string, title: string, version: number, content: string): string {
  const marker = /^## Spec\b.*$/m;
  const match = marker.exec(body);
  const before = (match === null ? body : body.slice(0, match.index)).trimEnd();
  const section = `## Spec — ${title} (v${version.toString()})\n\n${content.trim()}`;
  return before === '' ? section : `${before}\n\n${section}`;
}

async function createSparkFromChat(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  if (typeof args['body'] !== 'string' || args['body'].trim() === '') {
    return { error: 'body is required: provide the thought to save as a Spark.' };
  }
  const tags = args['tags'];
  const sparkTags: string[] = [];
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return { error: 'tags must be an array of non-empty tag names.' };
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim() === '') return { error: 'tags must be an array of non-empty tag names.' };
      sparkTags.push(tag.trim());
    }
  }
  const sourceId = args['sourceId'];
  const sourceType = args['sourceType'];
  if ((sourceId == null) !== (sourceType == null)) {
    return { error: 'sourceId and sourceType must both be present or both absent.' };
  }
  if (sourceId != null && (typeof sourceId !== 'string' || sourceId.trim() === '')) {
    return { error: 'sourceId must be a non-empty string.' };
  }
  if (sourceType != null && (typeof sourceType !== 'string' || sourceType.trim() === '')) {
    return { error: 'sourceType must be a non-empty string.' };
  }
  const spark = await createSpark(db, {
    body: args['body'].trim(),
    tags: [...new Set(sparkTags)],
    sourceId: typeof sourceId === 'string' ? sourceId.trim() : null,
    sourceType: typeof sourceType === 'string' ? sourceType.trim() : null,
  });
  return { created: true, spark, note: 'Saved in Sparks in the Think section. Confirm briefly using the saved body.' };
}

// ── create_note_draft ────────────────────────────────────────────────────────

function inferAthenaDraftContentType(title: string, content: string): typeof NOTE_CONTENT_TYPES[number] | null {
  const titleText = title.toLowerCase();
  const combined = `${title}\n${content}`.toLowerCase();
  const newsletterSignal =
    /\bnewsletter\b/.test(combined) ||
    /\breaching for the cloud\b/.test(combined) ||
    /\bedition\s+\d+\b/.test(titleText);
  const blogSignal =
    /\bblog post\b/.test(combined) ||
    /\bquick post\b/.test(combined) ||
    /\bfull post\b/.test(combined) ||
    /\bcms package\b/.test(combined) ||
    /\bthe microsoft cloud blog\b/.test(combined);

  if (newsletterSignal && !blogSignal) return 'newsletter';
  if (blogSignal && !newsletterSignal) return 'blog';
  if (/\bnewsletter edition\b/.test(titleText)) return 'newsletter';
  return null;
}

async function createNoteDraft(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const title = typeof args['title'] === 'string' && args['title'].trim() !== '' ? args['title'].trim() : 'Untitled';
  const content = typeof args['content'] === 'string' ? args['content'] : '';
  if (content.trim() === '') return { error: 'content is required' };
  const contentType = NOTE_CONTENT_TYPES.includes(args['contentType'] as typeof NOTE_CONTENT_TYPES[number])
    ? args['contentType'] as string
    : inferAthenaDraftContentType(title, content) ?? 'note';
  const requested = typeof args['projectId'] === 'string' && args['projectId'].trim() !== '' ? args['projectId'].trim() : null;
  const projectId = await resolveNoteProject(db, requested, title, content, contentType);

  const blocks = textToBlocks(content);
  const wrapper = { title, contentType, contentJson: JSON.stringify(blocks) };

  const note = await createNoteRecord(db, { content: JSON.stringify(wrapper), tags: [], projectId });
  const linkedArticles = await linkNoteToDiscoveredArticles(db, note.id, projectId, content).catch(() => 0);
  return {
    success: true,
    note: {
      id: note.id,
      title,
      contentType,
      projectId,
      ...(linkedArticles > 0 ? { linkedDiscoverArticles: linkedArticles } : {}),
      // Deep link back into the Think library — same pattern as summariseTask().
      url: `${env.FRONTEND_BASE_URL}/think?noteId=${note.id}`,
    },
  };
}

/**
 * Picks the project a new Athena note belongs to: a valid requested project, else the live project it most
 * directly serves (so an IMAGINE-relevant source note lands in IMAGINE, not the blog bucket), else the default.
 */
async function resolveNoteProject(db: Pool, requested: string | null, title: string, content: string, contentType: string): Promise<string> {
  if (requested !== null) {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM projects WHERE id = $1 OR lower(name) = lower($1) LIMIT 1`, [requested]);
    if (rows[0] !== undefined) return rows[0].id;
  }
  if (contentType !== 'blog' && contentType !== 'newsletter') {
    try {
      const { loadFocusProjects, assessProjectFit } = await import('../integrations/discovery/projectFit.js');
      const projects = await loadFocusProjects(db);
      const fits = (await assessProjectFit(new FoundryClient('note-project'), projects, [{ id: 'note', title, body: content, url: null }])).get('note') ?? [];
      const best = fits.find((f) => f.fit === STRONG_PROJECT_FIT)
        ?? fits.find((f) => f.fit === 1 && projects.find((p) => p.id === f.projectId)?.importance === 'high');
      if (best !== undefined) return best.projectId;
    } catch (err) {
      console.warn('[create_note_draft] project inference failed:', err instanceof Error ? err.message : String(err));
    }
  }
  return DEFAULT_ATHENA_NOTE_PROJECT_ID;
}

/**
 * When a note is written from a discovered article (e.g. a shared link), records the link on the article and, if the
 * note sits in a live project, treats the article as directly relevant to it — restoring it from Shelved.
 */
async function linkNoteToDiscoveredArticles(db: Pool, noteId: string, projectId: string, content: string): Promise<number> {
  const urls = content.match(/https?:\/\/[^\s)<>"\]]+/g) ?? [];
  if (urls.length === 0) return 0;
  const { rows: projectRows } = await db.query<{ name: string; importance: string | null }>(`SELECT name, importance FROM projects WHERE id = $1`, [projectId]);
  const project = projectRows[0];
  const { PROJECT_BOOST, PROJECT_PROTECT_BOOST, markUserInterest } = await import('../integrations/discovery/projectFit.js');
  const high = project?.importance === 'high' || project?.importance === 'critical';
  return markUserInterest(db, urls, {
    reason: 'note',
    noteId,
    // A note written from an article always keeps it out of the auto-shelf.
    boost: Math.max(PROJECT_PROTECT_BOOST, high ? PROJECT_BOOST.highDirect : PROJECT_BOOST.normalDirect),
    fit: project === undefined ? null : { projectId, name: project.name, fit: 2, why: 'You wrote a Think note from it' },
  });
}

// ── fetch_web_page ──────────────────────────────────────────────────────────

export async function fetchWebPage(args: Record<string, unknown>): Promise<unknown> {
  const rawUrl = typeof args['url'] === 'string' ? args['url'].trim() : '';
  if (rawUrl === '') return { error: 'url is required' };

  try {
    const { title, text } = await readPublicPage(rawUrl);
    const excerpt = readingExcerpt(text);
    return {
      success: true,
      url: rawUrl,
      title,
      content: excerpt.text,
      truncated: excerpt.truncated,
      coverage: excerpt.truncated ? 'Opening, middle and conclusion excerpts; not the full article' : 'Complete extracted page text',
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Fetch failed', url: rawUrl };
  }
}

// ── search_ica ───────────────────────────────────────────────────────────────

async function searchIca(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (query === '') return { error: 'query is required' };

  try {
    const { content, modelUsed } = await icaChat([
      {
        role: 'system',
        content:
          'You are being queried as a retrieval step by another assistant, not talking to the end user ' +
          'directly. Answer the question below using IBM-internal work context you have visibility into. Be ' +
          'factual and concise — state plainly if you have nothing relevant rather than guessing.',
      },
      { role: 'user', content: query },
    ]);
    return { success: true, source: 'ica', modelUsed, content };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'ICA request failed' };
  }
}
