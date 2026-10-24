import type { AiContext, AthenaPersona, ConversationMessage } from '../src/types/aiContext.js';

export interface DialogueExpectation {
  mode: 'explore' | 'deliver' | 'banter' | 'repair';
  maxWords: number;
  /** A requested draft can contain its own rhetorical question without interrogating the user. */
  allowEmbeddedQuestion?: boolean;
  /** Semantic smoke checks, not a substitute for reading the transcript. */
  mentions?: RegExp;
  avoids?: RegExp;
}

export interface DialogueScenario {
  id: string;
  persona: AthenaPersona;
  history?: ConversationMessage[];
  turns: Array<{ user: string; expect: DialogueExpectation }>;
}

// Synthetic reconstructions of the reported failure modes. No saved chats or customer data.
export const DIALOGUE_SCENARIOS: DialogueScenario[] = [
  {
    id: 'rtr-specification',
    persona: 'general',
    turns: [
      {
        user: 'I am trying to work out the right specification format for RTR, a synthetic reporting tool. A prose spec is easy to discuss, but a structured schema might be better for the coding agent. Help me think this through.',
        expect: { mode: 'explore', maxWords: 110, mentions: /agent|cod|spec|schema|format|human|read|consum|maintain/i },
      },
      {
        user: 'The main consumer is Copilot building the screens. I will review it, but it is not a stakeholder document.',
        expect: { mode: 'explore', maxWords: 110, mentions: /Copilot|agent|screen|build|test|acceptance|behavio|validat/i, avoids: /who (?:is|are).*(?:audience|consumer)|stakeholder sign.off/i },
      },
      {
        user: 'The real risk is contradictory screen behaviour. We have agreed YAML with stable screen IDs and acceptance examples. Give me a small example now, using one screen and one test. No more questions.',
        expect: { mode: 'deliver', maxWords: 280, mentions: /screen|acceptance|test/i, avoids: /who.*(?:audience|consumer)|would you like|shall I/i },
      },
    ],
  },
  {
    id: 'newsletter-intent',
    persona: 'general',
    turns: [
      {
        user: 'I am thinking of changing my synthetic cloud newsletter. It is becoming a list of announcements and I am not sure that is useful.',
        expect: { mode: 'explore', maxWords: 110, mentions: /reader|audience|read|use|decis|change|take away|help|do /i },
      },
      {
        user: 'The readers are hands-on Azure architects. I want them to decide what to try next week, not merely know what launched.',
        expect: { mode: 'explore', maxWords: 110, mentions: /try|architect|week|practical|experiment|decision|test/i, avoids: /who.*(?:reader|audience)|what.*(?:reader|audience).*target/i },
      },
      {
        user: 'Only free experiments taking less than an hour. Now draft a 90-word introduction explaining the new approach.',
        expect: { mode: 'deliver', maxWords: 130, allowEmbeddedQuestion: true, mentions: /(?:free|no.cost|without.*(?:cost|spend))|hour|60.minute/i },
      },
    ],
  },
  {
    id: 'brainstorming-challenge',
    persona: 'brainstorming',
    turns: [
      {
        user: 'What if our synthetic architecture workbench made every diagram node an autonomous agent? It sounds like a clean way to make the design executable.',
        expect: { mode: 'explore', maxWords: 110, mentions: /autonom|agent|execut|responsib|node|permission|decis|authorit/i, avoids: /great idea|absolutely|exactly right/i },
      },
      {
        user: 'I only mean simulation, not agents taking real actions. We need to reveal deadlocks before building anything.',
        expect: { mode: 'explore', maxWords: 110, mentions: /simulat|deadlock|model|state|depend|handoff|flow/i, avoids: /production permissions|who authorises real actions/i },
      },
    ],
  },
  {
    id: 'short-answer',
    persona: 'general',
    history: [
      { role: 'user', content: 'Help me think through a specification for a synthetic dashboard.' },
      { role: 'assistant', content: 'The format depends on its main consumer. Is the priority readability for stakeholder reviewers, or deterministic screen generation for Copilot?' },
    ],
    turns: [{
      user: 'The latter.',
      expect: { mode: 'explore', maxWords: 110, mentions: /Copilot|agent|screen|generat|structur|determin/i, avoids: /which.*(?:latter|option)|who.*consumer|stakeholder.*sign.off/i },
    }],
  },
  {
    id: 'direct-edit',
    persona: 'brainstorming',
    turns: [{
      user: 'Rewrite this sentence in plain English, keeping its meaning. Return only the new sentence: "The platform facilitates the orchestration of heterogeneous workloads."',
      expect: { mode: 'deliver', maxWords: 35, mentions: /platform|system|workload|work|task/i, avoids: /who.*audience|before.*rewrite|would you like/i },
    }],
  },
  {
    id: 'clear-comparison',
    persona: 'general',
    turns: [{
      user: 'In two sentences, explain the difference between YAML and JSON. I am not choosing a format, just asking what they are.',
      expect: { mode: 'deliver', maxWords: 90, mentions: /YAML[\s\S]*JSON|JSON[\s\S]*YAML/i, avoids: /who.*consumer|what.*building|would you like/i },
    }],
  },
  {
    id: 'playful-sarcasm',
    persona: 'general',
    turns: [{
      user: 'Brilliant, another meeting that could have been an email. The calendar has clearly developed a taste for hostages.',
      expect: { mode: 'banter', maxWords: 65, avoids: /^(?:yes|exactly|absolutely)\b|here are|three (?:ways|steps)|would you like/i },
    }],
  },
  {
    id: 'frustrated-correction',
    persona: 'general',
    turns: [
      {
        user: 'I want to explore whether a synthetic design spec should be prose or structured data.',
        expect: { mode: 'explore', maxWords: 110, mentions: /spec|prose|structur|consum|read|agent/i },
      },
      {
        user: 'No, you are still missing it. I am NOT asking you to choose a format. I am asking why a format is needed at all. Stop writing bloody essays.',
        expect: { mode: 'repair', maxWords: 90, mentions: /format|contract|agreement|shared|ambigu|consisten|interpret|reader|structure/i, avoids: /calendar hostage|calm down|as an AI|you seem upset/i },
      },
    ],
  },
  {
    id: 'complete-context',
    persona: 'general',
    turns: [{
      user: 'For a synthetic screen spec: Copilot is the consumer, YAML is chosen, stable IDs prevent drift, acceptance tests settle ambiguity. Generate a minimal two-field schema now, no discussion.',
      expect: { mode: 'deliver', maxWords: 160, mentions: /id|acceptance|test/i, avoids: /who.*consumer|why.*YAML|would you like/i },
    }],
  },
];

export const SYNTHETIC_DIALOGUE_CONTEXT: AiContext = {
  staticContext: 'Synthetic evaluation profile. Be direct, practical and concise. Legacy preference: always produce output first and do not ask questions.',
  projectContext: 'Synthetic sandbox only. No real projects, records or tasks are available.',
  projectReferences: [],
  activeProjectName: null,
  ragItems: [],
  ragQuery: '',
  memoryItems: [],
};

export function dialogueFindings(reply: string, expected: DialogueExpectation): string[] {
  const findings: string[] = [];
  const words = reply.trim().split(/\s+/).filter(Boolean).length;
  const questions = (reply.match(/\?/g) ?? []).length;
  if (reply.trim() === '') findings.push('empty reply');
  if (words > expected.maxWords) findings.push(`${words} words exceeds ${expected.maxWords}`);
  if (expected.mode === 'explore') {
    if (questions !== 1) findings.push(`exploratory reply needs one focused question, got ${questions}`);
    if (!/\?[\s"'”*_`]*$/.test(reply)) findings.push('did not pause at the question');
    if (/\b(?:anything else|would you like me to|shall I (?:draft|write|generate))\b/i.test(reply)) findings.push('generic offer instead of consequential curiosity');
    if (/^#{1,3} /m.test(reply)) findings.push('essay headings during exploration');
  } else if (expected.mode === 'deliver' || expected.mode === 'banter') {
    if (questions !== 0 && !expected.allowEmbeddedQuestion) findings.push(`unnecessary question in ${expected.mode} reply`);
    if (/\b(?:if you want|would you like|shall I|anything else)\b/i.test(reply)) findings.push('unsolicited offer instead of stopping');
  }
  if (expected.mentions !== undefined && !expected.mentions.test(reply)) findings.push('missing scenario-specific subject');
  if (expected.avoids?.test(reply)) findings.push('repeated known information or unwanted framing');
  return findings;
}
