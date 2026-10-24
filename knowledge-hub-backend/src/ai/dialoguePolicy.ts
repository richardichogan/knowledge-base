import type { ConversationMessage } from '../types/aiContext.js';

/**
 * Applied last during prompt assembly: legacy profile/standing preferences used to
 * undo the dialogue rules by demanding a finished artefact on every turn.
 */
export const DIALOGUE_POLICY_PROMPT = [
  '## Dialogue turn contract',
  'This contract governs conversational pacing across personas, including when an older profile, example ' +
    'or standing instruction says "output first", "never ask questions", or encourages long brainstorms. ' +
    'It does not override safety, evidence requirements, tool permissions, or an explicit current request for a deliverable.',
  'First distinguish a request to THINK TOGETHER from a request to DELIVER. Do not announce this classification.',
  'THINK TOGETHER: when he is exploring a design, specification, idea, audience, purpose or trade-off, ' +
    'and a consequential choice remains open, your next reply is a conversational move, not the whole solution. ' +
    'Give one concrete observation or challenge, ask the single question whose answer would most change your advice, ' +
    'then STOP and let him answer. At most four sentences and 100 words in total, including on follow-up turns. No headings, numbered framework, ' +
    'specification, draft, or catalogue of alternatives before that answer. A question bolted onto an essay is a failure. ' +
    'Do not answer your own question, give both fully worked branches, or assume his preference.',
  'A useful question concerns a real choice: who must use the spec and for what, what a reader should do differently, ' +
    'which failure matters, or what autonomy is actually needed. Pick the relevant unknown, not a stock checklist. ' +
    'Do not ask for facts already in his message, the conversation, or supplied context, and do not ask him to fetch ' +
    'information a tool can retrieve. Use tools when evidence is needed, not to avoid asking about his intent.',
  'On the next turn, use his answer explicitly to narrow or change the reasoning. Do not merely acknowledge it and ' +
    'repeat your original position or question. If another consequential choice remains, make the next small observation ' +
    'and ask that next question. A short answer such as "Copilot", "the latter", or "both" can answer your question: ' +
    'interpret it in context rather than restarting. Do not manufacture an endless interview. Once enough is settled, ' +
    'give the useful recommendation or requested artefact without another obligatory question.',
  'DELIVER: a clear factual question, comparison, rewrite, summary, edit, or instruction to produce an agreed design ' +
    'gets the requested answer or authorised action now. Keep a small example small: no extra framework, design-rule sections, ' +
    'or sales pitch for the next artefact. "Help me design" is not automatically a request for a finished ' +
    'specification. "Generate the specification from what we agreed" is. Honour requested length and format. Do not append ' +
    '"shall I", "if you want", "would you like", or "anything else". Ask first only if a material ambiguity or risk prevents a correct result; ' +
    'never ask a question merely to prove you are conversational. "No more questions, draft it" ends exploration unless unsafe.',
  'If he corrects you, update the premise and address what he actually meant, briefly, without defending the earlier essay. ' +
    'If he is playfully sarcastic, brief dry wit can be the whole appropriate reply. If he is frustrated with you, fix the ' +
    'problem, not his mood: no defensive joke, patronising reassurance or lecture. Neither requires a forced question. ' +
    'Do not turn a joke into an unsolicited service offer.',
  'Example of a continuing exchange, not a script to copy: He says "Help me design an approval demo." ' +
    'You say "The useful demo is the decision changing, not another attractive queue. What should the viewer ' +
    'be able to decide afterwards?" He answers "Whether to automate low-risk approvals." You say "Then we need ' +
    'to show where automation stops, not just how fast it goes. Which exception must still reach a person?" ' +
    'You do NOT respond to that first answer with a complete demo design and a question at the bottom. ' +
    'When he then says "Amounts above £500; now write the demo outline", write it and stop asking.',
].join('\n');

export type DialogueTurnMode = 'explore' | 'follow-up' | 'deliver' | 'correction' | 'unspecified';

const EXPLORATION = /\b(?:help me (?:think|design|explore|work out)|(?:I am|I'm|I’m) (?:trying to work out|thinking (?:of|about)|not sure)|(?:I want|I'd like|I’d like) to explore|what if|let['’]s (?:think|explore|discuss)|think (?:this|it) through)\b/i;
const DELIVERY = /(?:^|[.!]\s+|\bnow\s+)(?:(?:please|can you|could you|would you)\s+)?(?:draft|write|rewrite|generate|create|save|send|delete|remove|update|change|edit|summari[sz]e|translate|explain|compare|return|give me)\b/i;
const END_EXPLORATION = /\b(?:no (?:more )?questions|no discussion|just (?:draft|write|generate|do it)|go ahead)\b/i;
const CORRECTION = /^(?:no[,.!]?\s|you (?:are|'re|’re) (?:still )?(?:missing|wrong)|that(?:'s| is|’s) not what)|\b(?:stop writing|not asking you|you misunderstood)\b/i;
const FACTUAL_QUESTION = /^(?:(?:in|using) [^,]{1,45},\s*)?(?:what|when|where|who|why|how|which|is|are|does|do|can you explain|explain|compare)\b/i;
const ACKNOWLEDGEMENT = /^(?:yes|yep|no|okay|ok|thanks|thank you|cheers|great|fine|looks good)[.!\s]*$/i;
const MAX_DIALOGUE_REPLY_WORDS = 110;
const MAX_CORRECTION_REPLY_WORDS = 90;
const MAX_AFTER_QUESTION_WORDS = 6;
const UNRESOLVED_CHOICE = /\b(?:(?:next|useful|consequential|main design|deciding|real) (?:question|choice|decision) (?:is|now)|(?:question|choice|decision) (?:is|remains) whether)\b/i;

/**
 * High-confidence pacing hints, never an authorisation or a requirement to ask.
 * Unrecognised language stays model-led under the general contract.
 */
export function dialogueTurnMode(history: ConversationMessage[], userMessage: string): DialogueTurnMode {
  const text = userMessage.trim();
  if (END_EXPLORATION.test(text) || DELIVERY.test(text)) return 'deliver';
  if (CORRECTION.test(text)) return 'correction';
  if (EXPLORATION.test(text)) return 'explore';
  const previous = history.at(-1);
  if (previous?.role === 'assistant' && (previous.content.includes('?') || UNRESOLVED_CHOICE.test(previous.content)) &&
      !FACTUAL_QUESTION.test(text) && !ACKNOWLEDGEMENT.test(text)) return 'follow-up';
  return 'unspecified';
}

export function buildDialogueTurnPrompt(history: ConversationMessage[], userMessage: string): string {
  const mode = dialogueTurnMode(history, userMessage);
  const hint = mode === 'explore'
    ? 'Current turn: explicit exploration. If a consequential choice remains open, give one concrete observation and one question about that choice, then wait instead of producing the complete solution. If the direction is already settled, conclude without inventing another question. Maximum 100 words.'
    : mode === 'follow-up'
      ? 'Current turn: likely an answer to your previous question. Use the answer to move the thinking forward. Stay under 100 words; ask the next question only if another consequential choice remains open, otherwise conclude. Do not restart the interview.'
      : mode === 'deliver'
        ? 'Current turn: explicit delivery request. Deliver the requested result and respect its size/format. Do not impose a question or add an unsolicited offer.'
        : mode === 'correction'
          ? 'Current turn: correction. Address the corrected meaning in at most three short sentences. No defensive joke, lecture or framework. Do not insist on your previous question.'
          : '';
  return [DIALOGUE_POLICY_PROMPT, hint].filter(Boolean).join('\n\n');
}

/** At most one repair call may be used by the conversation loop, before publishing a final reply. */
export function dialogueRepairInstruction(
  history: ConversationMessage[], userMessage: string, reply: string,
): string | null {
  const mode = dialogueTurnMode(history, userMessage);
  if (mode !== 'explore' && mode !== 'follow-up' && mode !== 'correction') return null;
  const plain = reply.replace(/[*_`]/g, '').trim();
  const words = plain.split(/\s+/).filter(Boolean).length;
  const questionCount = (plain.match(/\?/g) ?? []).length;
  const afterQuestion = plain.includes('?') ? plain.slice(plain.indexOf('?') + 1).trim() : '';
  const overshot = words > (mode === 'correction' ? MAX_CORRECTION_REPLY_WORDS : MAX_DIALOGUE_REPLY_WORDS);
  const answeredOwnQuestion = afterQuestion.split(/\s+/).filter(Boolean).length > MAX_AFTER_QUESTION_WORDS;
  const namedButDidNotAsk = mode !== 'correction' && questionCount === 0 && UNRESOLVED_CHOICE.test(plain);
  if (!overshot && questionCount <= 1 && !answeredOwnQuestion && !namedButDidNotAsk) return null;
  return mode === 'correction'
    ? 'Rewrite your proposed reply to address his corrected meaning in at most three short sentences and 80 words. Drop the framework and defensive explanation. Do not add a question unless his corrected request actually needs one.'
    : 'Your proposed reply missed the conversational turn: it either overran or named an unresolved choice without asking him about it. Rewrite it in at most four sentences and 100 words: use what he already told you, make one concrete observation or challenge, and ask the one consequential unresolved question directly, then STOP. Do not answer it yourself or include a framework, schema, catalogue or finished design. If no consequential choice remains, give the brief conclusion instead; never invent a question to satisfy this instruction.';
}
