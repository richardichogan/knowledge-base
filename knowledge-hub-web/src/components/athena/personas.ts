/**
 * components/athena/personas.ts — the single list of Athena personas.
 * Every persona picker (chip, menus) and label reads from here, so adding a
 * persona is one entry rather than edits in several components.
 */
import { Blog, Compass, Document, Idea, Notebook, Screen, Microphone, ColorPalette } from '@carbon/icons-react';
import type { AthenaPersona } from '../../types';

export interface PersonaDefinition {
  id: AthenaPersona;
  label: string;
  description: string;
  Icon: typeof Notebook;
}

export const PERSONAS: readonly PersonaDefinition[] = [
  { id: 'general', label: 'General', description: 'General assistant across your notes, tasks and library', Icon: Notebook },
  { id: 'brainstorming', label: 'Brainstorm', description: 'Ideas sounding board — stress-tests and sharpens early-stage thinking', Icon: Idea },
  { id: 'copilot_coach', label: 'Copilot Coach', description: 'Expert guide on GitHub Copilot agents, skills and workflows', Icon: Compass },
  { id: 'blog_post', label: 'Blog Post', description: 'Produces a full CMS-ready package for The Microsoft Cloud Blog', Icon: Blog },
  { id: 'demo_designer', label: 'Demo Designer', description: 'Shapes demos and creates evidence-led IMAGINE business briefs for GHCP', Icon: Screen },
  { id: 'web_designer', label: 'Web Designer', description: 'Designs and reviews websites and pages: mock-ups you can see, live-site reviews, build prompts', Icon: ColorPalette },
  { id: 'podcast_prep', label: 'Podcast Prep', description: 'Prepares your Cloudy segments: fresh topics, openers, running order and notes', Icon: Microphone },
  { id: 'podcast_show_notes', label: 'Show Notes', description: 'Turns an episode transcript into show notes, a companion blog post and the social campaign', Icon: Document },
];

const BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));

/** Looks up a persona, falling back to General for unknown/legacy ids. */
export function getPersona(id: string | undefined): PersonaDefinition {
  return BY_ID.get(id as AthenaPersona) ?? PERSONAS[0]!;
}
