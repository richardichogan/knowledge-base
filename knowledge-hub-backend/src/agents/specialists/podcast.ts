import { draftScript, getEpisode } from '../../podcasts/podcastEpisodeStore.js';
import { ValidationError } from '../../types/errors.js';
import { registerSpecialist } from '../registry.js';
import { createPodcastShowNotes } from '../../ai/podcastShowNotes.js';

registerSpecialist({
  id: 'podcast-script-writer',
  name: 'Podcast script writer',
  description: 'Drafts a Podcast episode script from its edited Prep document and supporting conversation history, including a light synopsis style pass. Requires the current episode revision and confirmation before replacing an existing script.',
  subjectType: 'podcast-episode',
  resolveSubject: async (db, id) => {
    const episode = await getEpisode(db, id);
    if (!episode.prepHasContent && !episode.prepSessionId) throw new ValidationError('This episode has no prep document to draft from.');
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

registerSpecialist({
  id: 'podcast-show-notes-writer',
  name: 'Podcast show-notes writer',
  description: 'Creates the complete show-notes package from an uploaded episode transcript, verifies reference links using episode prep, and saves it directly to the Show Notes tab. Does not publish or overwrite existing show notes.',
  subjectType: 'podcast-episode',
  resolveSubject: async (db, id) => {
    const episode = await getEpisode(db, id);
    if (!episode.transcript) throw new ValidationError('Upload the transcript before creating show notes.');
    if (episode.showNotesNoteId) throw new ValidationError('This episode already has show notes. Edit the existing document instead.');
    return { id: episode.noteId, title: episode.title, url: `/think?episode=${encodeURIComponent(episode.noteId)}&tab=show_notes` };
  },
  parseInput: input => {
    const revision = input['revision'];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      throw new ValidationError('The current episode revision is required to create show notes.');
    }
    return { revision };
  },
  run: async context => {
    const episode = await createPodcastShowNotes(context.db, context.subjectId, Number(context.input['revision']), context);
    return { data: { noteId: episode.noteId, showNotesNoteId: episode.showNotesNoteId,
      url: `/think?episode=${encodeURIComponent(episode.noteId)}&tab=show_notes`, revision: episode.revision },
    summary: 'The show-notes package is saved in the episode, including copyable Spotify HTML and reference links or explicit verification limitations.' };
  },
});
