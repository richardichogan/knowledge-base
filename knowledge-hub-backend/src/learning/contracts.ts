import { ValidationError } from '../types/errors.js';
import type { LlmJsonSchema } from '../ai/foundryClient.js';

export const LEARNING_LIMITS = {
  questions: 10, choices: 4, maxAnswerIndex: 3, topicChars: 160, promptChars: 2000, optionChars: 900,
  explanationChars: 3500, optionExplanationChars: 2200, replyChars: 9000, evidenceCount: 8,
  passageChars: 1200, passageBoundary: 600, minimumQuote: 25, repairAttempts: 2,
  questionTokens: 6500, reviewTokens: 3000, replyTokens: 4500, replyReviewTokens: 2500,
  recentAnswers: 10, minimumHistory: 3, focusFraction: 0.6, historyPage: 20, percent: 100,
} as const;
export interface Evidence { source: number; quote: string }
export interface LearningSource { url: string; title: string; text: string; hash: string; checkedAt: string }
export interface LearningOption { text: string; explanation: string; evidence: Evidence[] }
export interface LearningQuestion {
  category: 'strategy' | 'enablement' | 'product';
  level: 'foundation' | 'practitioner' | 'advanced';
  ecosystem: 'Microsoft' | 'GitHub';
  topicId?: string;
  topic: string; question: string; options: LearningOption[]; correct: number; explanation: string; evidence: Evidence[];
  sources: LearningSource[];
}
export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected a learning request object.');
  return value as Record<string, unknown>;
};
export const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ValidationError(`${label} must contain 1 to ${max} characters.`);
  return value.trim();
};
export const normaliseEvidence = (value: string): string => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
export function learningExplanation(value: unknown, label: string, max: number): string {
  const explanation = text(value, label, max);
  if (/\b(?:option|answer|choice)\s*(?:number\s*|#\s*)?\d+\b|\b(?:first|second|third|fourth|1st|2nd|3rd|4th)\s+(?:option|answer|choice)\b/i.test(explanation)
    || /\b(?:[Oo]ption|[Aa]nswer|[Cc]hoice)\s+[A-D]\b/.test(explanation)) {
    throw new ValidationError(`${label} must identify answers by their content, not option numbers, letters or positions.`);
  }
  return explanation;
}
export function sourcePassages(text: string): { id: number; text: string }[] {
  const passages: { id: number; text: string }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + LEARNING_LIMITS.passageChars, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start + LEARNING_LIMITS.passageBoundary) end = boundary;
    }
    const passage = text.slice(start, end).trim();
    if (passage) passages.push({ id: passages.length, text: passage });
    start = end;
  }
  return passages;
}
export const sourceInput = (sources: LearningSource[]): unknown =>
  sources.map(source => ({ url: source.url, title: source.title, passages: sourcePassages(source.text) }));
export function evidence(value: unknown, sources: LearningSource[]): Evidence[] {
  if (!Array.isArray(value) || !value.length || value.length > LEARNING_LIMITS.evidenceCount) throw new ValidationError('Learning claims require official-source evidence.');
  return value.map(item => {
    const ref = record(item);
    const source = ref['source'];
    const passage = ref['passage'];
    if (typeof source !== 'number' || !Number.isInteger(source) || !sources[source]
      || typeof passage !== 'number' || !Number.isInteger(passage)) {
      throw new ValidationError('Learning evidence requires valid official-source and passage indices.');
    }
    const quote = sourcePassages(sources[source].text)[passage]?.text;
    if (!quote || quote.length < LEARNING_LIMITS.minimumQuote) throw new ValidationError('Learning evidence refers to a missing or insufficient source passage.');
    return { source, quote };
  });
}
const string = { type: 'string' };
const objectSchema = (properties: Record<string, unknown>): Record<string, unknown> =>
  ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const evidenceRefSchema = objectSchema({ source: { type: 'integer', minimum: 0 }, passage: { type: 'integer', minimum: 0 } });
const evidenceSchema = { type: 'array', minItems: 1, maxItems: 8, items: evidenceRefSchema };
export const QUESTION_SCHEMA: LlmJsonSchema = { name: 'learning_question', schema: objectSchema({
  topic: string, question: string, correct: { type: 'integer', minimum: 0, maximum: 3 }, explanation: string, evidence: evidenceSchema,
  options: { type: 'array', minItems: 4, maxItems: 4, items: objectSchema({ text: string, explanation: string, evidence: evidenceSchema }) },
}) };
export const REVIEW_SCHEMA: LlmJsonSchema = { name: 'learning_review', schema: objectSchema({
  pass: { type: 'boolean' }, correct: { type: 'integer', minimum: -1, maximum: 3 },
  blockingIssues: { type: 'array', items: string }, rationale: string,
}) };
export const REPLY_SCHEMA: LlmJsonSchema = { name: 'learning_reply', schema: objectSchema({
  supported: { type: 'boolean' }, answer: string, evidence: { type: 'array', maxItems: 8, items: evidenceRefSchema },
}) };

export function parseQuestion(value: unknown, sources: LearningSource[], category: LearningQuestion['category'],
  level: LearningQuestion['level'], ecosystem: LearningQuestion['ecosystem']): LearningQuestion {
  const q = record(value);
  if (!Array.isArray(q['options']) || q['options'].length !== LEARNING_LIMITS.choices
    || typeof q['correct'] !== 'number' || !Number.isInteger(q['correct']) || q['correct'] < 0 || q['correct'] > LEARNING_LIMITS.maxAnswerIndex) {
    throw new ValidationError('A learning question needs four options and exactly one correct answer.');
  }
  const options = q['options'].map(item => {
    const option = record(item);
    return { text: text(option['text'], 'Option', LEARNING_LIMITS.optionChars), explanation: learningExplanation(option['explanation'], 'Option explanation', LEARNING_LIMITS.optionExplanationChars),
      evidence: evidence(option['evidence'], sources) };
  });
  if (new Set(options.map(option => normaliseEvidence(option.text).toLowerCase())).size !== LEARNING_LIMITS.choices) {
    throw new ValidationError('Learning answer options must be distinct.');
  }
  return { category, level, ecosystem, sources, topic: text(q['topic'], 'Topic', LEARNING_LIMITS.topicChars), question: text(q['question'], 'Question', LEARNING_LIMITS.promptChars),
    options, correct: q['correct'], explanation: learningExplanation(q['explanation'], 'Explanation', LEARNING_LIMITS.explanationChars), evidence: evidence(q['evidence'], sources) };
}
