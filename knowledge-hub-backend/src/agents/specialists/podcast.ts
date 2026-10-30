import { draftScript, getEpisode } from '../../podcasts/podcastEpisodeStore.js';
import { ValidationError } from '../../types/errors.js';
import { registerSpecialist } from '../registry.js';

registerSpecialist({
  id: 'podcast-script-writer',
  name: 'Podcast script writer',
  description: 'Drafts a Podcast episode script from its Prep conversation, including a light synopsis style pass. Requires the current episode revision and confirmation before replacing an existing script.',
  subjectType: 'podcast-episode',
  resolveSubject: async (db, id) => {
    const episode = await getEpisode(db, id);
    if (!episode.prepSessionId) throw new ValidationError('This episode has no prep conversation to draft from.');
    return { id: episode.noteId, title: episode.title, url: `/think?episode=${encodeURIComponent(episode.noteId)}&tab=script` };
  },
  parseInput: input => {
    const revision = input['revision'];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      throw new ValidationError('The current episode revision is required to draft its script.');
    }
    return { revision };
  },
  overwrites: async (db, id) => {
    const episode = await getEpisode(db, id);
    return !!episode.scriptIntro || episode.scriptCards.length > 0;
  },
  run: async ({ db, subjectId, input, progress, signal, jobId, attempt }) => {
    const episode = await draftScript(db, subjectId, input, { progress, signal, jobId, attempt });
    progress('Script saved to the episode');
    return {
      data: { noteId: episode.noteId, url: `/think?episode=${encodeURIComponent(episode.noteId)}&tab=script`, revision: episode.revision },
      summary: 'The intro and topic cards are saved, including the light synopsis style pass.',
    };
  },
});
