/**
 * Identity icon set — project icons and content-type icons share one vocabulary.
 */
import type { CarbonIconType } from '@carbon/icons-react';
import {
  Idea, Building, Cube, Finance, Security, Template, Star, Dashboard, Partnership, Store,
  Chemistry, Microphone, Email, Video, Cloud, PresentationFile, Laptop, Pen, MachineLearningModel,
  Rocket, Diagram, Flow, Queued, HealthCross, Home, Education, User, Folder, Document, Notebook,
  Blog, Task, Lightning, Report, Book, Microscope, Code, Calendar, Chat, Bullhorn, Analytics,
  Globe, Bot, Gem, Trophy, Compass, Tree, Wallet, Growth, Earth, Headphones, Network_3,
} from '@carbon/icons-react';

export const IDENTITY_ICONS: Record<string, { icon: CarbonIconType; label: string }> = {
  folder:       { icon: Folder, label: 'Folder' },
  idea:         { icon: Idea, label: 'Idea' },
  building:     { icon: Building, label: 'Building' },
  atom:         { icon: Cube, label: 'Cube' },
  finance:      { icon: Finance, label: 'Finance' },
  security:     { icon: Security, label: 'Security' },
  blueprint:    { icon: Template, label: 'Blueprint' },
  star:         { icon: Star, label: 'Star' },
  dashboard:    { icon: Dashboard, label: 'Dashboard' },
  partnership:  { icon: Partnership, label: 'Partnership' },
  store:        { icon: Store, label: 'Store' },
  flask:        { icon: Chemistry, label: 'Flask' },
  microphone:   { icon: Microphone, label: 'Microphone' },
  email:        { icon: Email, label: 'Email' },
  video:        { icon: Video, label: 'Video' },
  cloud:        { icon: Cloud, label: 'Cloud' },
  presentation: { icon: PresentationFile, label: 'Presentation' },
  laptop:       { icon: Laptop, label: 'Laptop' },
  pen:          { icon: Pen, label: 'Pen' },
  brain:        { icon: MachineLearningModel, label: 'Brain' },
  rocket:       { icon: Rocket, label: 'Rocket' },
  diagram:      { icon: Diagram, label: 'Diagram' },
  flow:         { icon: Flow, label: 'Flow' },
  queue:        { icon: Queued, label: 'Queue' },
  health:       { icon: HealthCross, label: 'Health' },
  home:         { icon: Home, label: 'Home' },
  education:    { icon: Education, label: 'Education' },
  user:         { icon: User, label: 'Person' },
  book:         { icon: Book, label: 'Book' },
  code:         { icon: Code, label: 'Code' },
  chart:        { icon: Analytics, label: 'Chart' },
  globe:        { icon: Globe, label: 'Globe' },
  bot:          { icon: Bot, label: 'Bot' },
  gem:          { icon: Gem, label: 'Gem' },
  trophy:       { icon: Trophy, label: 'Trophy' },
  compass:      { icon: Compass, label: 'Compass' },
  tree:         { icon: Tree, label: 'Tree' },
  wallet:       { icon: Wallet, label: 'Wallet' },
  growth:       { icon: Growth, label: 'Growth' },
  earth:        { icon: Earth, label: 'Earth' },
  headphones:   { icon: Headphones, label: 'Headphones' },
  network:      { icon: Network_3, label: 'Network' },
  bullhorn:     { icon: Bullhorn, label: 'Bullhorn' },
  lightning:    { icon: Lightning, label: 'Lightning' },
};

export const PROJECT_ICON_KEYS = Object.keys(IDENTITY_ICONS);

/** Content types are identified by icon only — never by colour. */
const CONTENT_TYPE_ICON: Record<string, CarbonIconType> = {
  note: Notebook,
  project: Folder,
  blog: Blog,
  podcast: Microphone,
  'podcast-show-notes': Headphones,
  newsletter: Email,
  script: Document,
  architecture: Diagram,
  meeting: Calendar,
  research: Microscope,
  spec: Report,
  'use-case': Task,
  chat: Chat,
};

export function identityIcon(key: string | null | undefined): CarbonIconType {
  return (key != null ? IDENTITY_ICONS[key]?.icon : undefined) ?? Folder;
}

export function contentTypeIcon(type: string): CarbonIconType {
  return CONTENT_TYPE_ICON[type] ?? Document;
}
