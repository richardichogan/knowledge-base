export const PROJECT_TYPES = ['project', 'opportunity', 'offering', 'bau', 'aspiration', 'exploration', 'side-project'] as const;
export type ProjectType = typeof PROJECT_TYPES[number];
