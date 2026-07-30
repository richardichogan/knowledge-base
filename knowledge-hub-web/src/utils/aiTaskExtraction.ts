/**
 * AI-assisted task extraction — used by the "Create Task" context-menu action.
 *
 * Asks the assistant to look at arbitrary selected content and decide how many
 * distinct, actionable tasks it actually represents (could be one, could be
 * several — e.g. a paragraph describing three separate follow-ups). Falls
 * back to the simple line-based heuristic if the AI call fails or returns
 * something we can't parse, so the feature still works offline/on error.
 */

import { api } from '../services/api';
import { parseTasksFromText, type ParsedTaskDraft } from './taskParsing';

const MAX_INPUT_CHARS = 3000;

function stripCodeFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
}

function isParsedTaskDraft(val: unknown): val is ParsedTaskDraft {
  return (
    typeof val === 'object' && val !== null &&
    typeof (val as Record<string, unknown>)['title'] === 'string' &&
    typeof (val as Record<string, unknown>)['body'] === 'string'
  );
}

export async function extractTasksWithAI(text: string): Promise<ParsedTaskDraft[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const prompt = `You are a task extraction assistant. Read the following content and decide how many distinct, actionable tasks it actually represents.
- If it describes a single action or idea, return exactly one task.
- If it contains multiple separate action items (e.g. a list of steps, several distinct follow-ups, or multiple requests bundled together), return one task per distinct action.
- Do not invent tasks that aren't supported by the text.

Return ONLY a JSON array (no markdown, no explanation), where each item has:
- "title": short action-oriented title (max 12 words)
- "body": a 1-2 sentence description of what needs to be done

Content:
"""
${trimmed.slice(0, MAX_INPUT_CHARS)}
"""

Respond with only the JSON array.`;

  try {
    const res = await api.chat({ message: prompt });
    if (!res.success || !res.data) return parseTasksFromText(trimmed);

    const raw = stripCodeFence(res.data.reply);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return parseTasksFromText(trimmed);

    const drafts = parsed.filter(isParsedTaskDraft);
    return drafts.length > 0 ? drafts : parseTasksFromText(trimmed);
  } catch {
    return parseTasksFromText(trimmed);
  }
}
