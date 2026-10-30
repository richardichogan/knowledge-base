import { scriptSentenceLines } from '../features/podcasts/scriptFormatting';

export interface ScriptCard { id: string; title: string; synopsis: string; bullets: string[] }
export interface PodcastEpisode {
  noteId: string;
  title: string;
  episodeNumber: number | null;
  recordingDate: string | null;
  prepSessionId: string | null;
  scriptIntro: string;
  scriptCards: ScriptCard[];
  transcript: string | null;
  transcriptFilename: string | null;
  transcriptUploadedAt: string | null;
  showNotesSessionId: string | null;
  showNotesNoteId: string | null;
  revision: number;
}
export const PODCAST_EPISODE_TABS = [
  { key: 'prep', label: 'Prep' }, { key: 'script', label: 'Script' }, { key: 'transcript', label: 'Transcript' },
  { key: 'show_notes', label: 'Show Notes' }, { key: 'campaign', label: 'Campaign' },
] as const;
export type PodcastEpisodeTab = typeof PODCAST_EPISODE_TABS[number]['key'];
export function episodeUrl(noteId: string, tab: PodcastEpisodeTab = 'prep'): string {
  return `/think?episode=${encodeURIComponent(noteId)}&tab=${tab}`;
}

/** Plain text sent to the Elgato presenter: the intro, then each topic card with its bullet points. */
export function episodeScriptText(intro: string, cards: ScriptCard[]): string {
  return [scriptSentenceLines(intro), ...cards.map(card => [card.title.trim(), scriptSentenceLines(card.synopsis),
    card.bullets.map(item => item.trim()).filter(Boolean).map(item => `• ${scriptSentenceLines(item)}`).join('\n\n')].filter(Boolean).join('\n\n'))]
    .filter(Boolean).join('\n\n');
}
