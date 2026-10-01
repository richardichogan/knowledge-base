/**
 * ai/nextSteps.ts — 2–3 short next steps suggested after a reply, shown as
 * buttons; clicking one sends it as his next message. A small, fast model
 * call; never holds a reply up for long.
 */
import { getFoundryClient } from './foundryClient.js';

const PERSONA_HINTS: Record<string, string> = {
  demo_designer: 'Typical next steps here: write the GHCP prompt for the agreed changes; save a demo spec; review the screens against the user stories; draft the demo script.',
  podcast_prep: 'Typical next steps here: go with option 1; write the segment prep notes; check whether David or Cyrus already has it.',
  blog_post: 'Typical next steps here: tighten the intro; adjust the social posts; check the sources.',
  brainstorming: 'Typical next steps here: stress-test the riskiest assumption; turn it into a one-page outline; name the first experiment.',
};

const TIMEOUT_MS = 6_000;

export async function suggestNextSteps(persona: string, userMessage: string, reply: string): Promise<string[]> {
  const call = getFoundryClient().chat('gpt-4o', [
    {
      role: 'system',
      content: [
        'Suggest 2 or 3 next steps Richard is most likely to want after this reply from his assistant Athena.',
        'Each is written as the message he would send, in his voice, imperative, under 8 words (e.g. "Write the GHCP prompt").',
        'Make them specific to this conversation, not generic. Nothing that just repeats the reply.',
        PERSONA_HINTS[persona] ?? '',
        'Return ONLY a JSON array of strings. If the reply needs no follow-up (small talk, a simple fact), return [].',
      ].filter(Boolean).join('\n'),
    },
    { role: 'user', content: `Richard: ${userMessage.slice(0, 1_500)}\n\nAthena: ${reply.slice(0, 4_000)}` },
  ], 200);
  const timeout = new Promise<string>((resolve) => { setTimeout(() => { resolve('[]'); }, TIMEOUT_MS).unref(); });
  try {
    const raw = await Promise.race([call, timeout]);
    const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
    const steps = JSON.parse(json) as unknown;
    return Array.isArray(steps)
      ? steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().slice(0, 80)).slice(0, 3)
      : [];
  } catch {
    return [];
  }
}
