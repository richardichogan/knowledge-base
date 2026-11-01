import { draftScript, getEpisode } from '../../podcasts/podcastEpisodeStore.js';
import { ValidationError } from '../../types/errors.js';
import { registerSpecialist } from '../registry.js';
import { createPodcastShowNotes } from '../../ai/podcastShowNotes.js';
import { prepareRecordingTeaser } from '../../publishing/podcastRecordingTeaser.js';
import { getPodcastCampaign } from '../../publishing/podcastCampaignStore.js';
import { runPodcastCreationReview } from '../../publishing/podcastCampaignReview.js';

registerSpecialist({
  id: 'podcast-publication-reviewer',
  name: 'Independent podcast publication reviewer',
  description: 'Inspects finished PNGs and exact saved posts against episode source using a different model from creation. Saves concrete findings and blocks approval until the current version passes. Never edits copy, artwork or dates, and never publishes.',
  subjectType: 'podcast-campaign',
  resolveSubject: async (db, id) => {
    const campaign = await getPodcastCampaign(db, id);
    if (!campaign.plan || campaign.state !== 'draft') throw new ValidationError('Independent review needs a saved draft campaign or teaser.');
    const parent = campaign.plan.recordingTease ? id : (await db.query<{ note_id: string }>('SELECT note_id FROM podcast_episodes WHERE show_notes_note_id=$1', [id])).rows[0]?.note_id;
    return { id, title: campaign.plan.title, url: parent ? `/think?episode=${encodeURIComponent(parent)}&tab=campaign` : `/think?note=${encodeURIComponent(id)}` };
  },
  parseInput: input => {
    if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new ValidationError('Independent review needs the saved campaign revision.');
    return { revision: input.revision };
  },
  run: async context => {
    await runPodcastCreationReview(context);
    return { data: { noteId: context.subjectId, revision: context.input.revision },
      summary: 'A separate model inspected the finished images and posts. This version passed independent review and still requires your manual approval.' };
  },
});

registerSpecialist({
  id: 'podcast-recording-teaser-writer',
  name: 'Podcast recording teaser writer',
  description: 'Prepares the complete personal LinkedIn and Bluesky recording teaser immediately from the uploaded transcript, or uses its existing Show Notes copy. No episode URLs or full campaign generation. Saves a separate draft in Campaign for approval; never overwrites an existing teaser.',
  subjectType: 'podcast-episode',
  resolveSubject: async (db, id) => {
    const episode = await getEpisode(db, id);
    if (!episode.transcript) throw new ValidationError('Upload the transcript before preparing the teaser.');
    if ((await getPodcastCampaign(db, id)).plan) throw new ValidationError('The recording teaser already exists. Edit or approve it instead of regenerating it.');
    return { id, title: episode.title, url: `/think?episode=${encodeURIComponent(id)}&tab=campaign` };
  },
  parseInput: input => {
    if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision)) throw new ValidationError('The current episode revision is required.');
    return { revision: input.revision };
  },
  run: async context => {
    await prepareRecordingTeaser(context);
    return { data: { noteId: context.subjectId, url: `/think?episode=${encodeURIComponent(context.subjectId)}&tab=campaign` },
      summary: 'The recording teaser is saved in Campaign. Independent image/post review is queued; manual approval stays blocked until it passes.' };
  },
});

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
