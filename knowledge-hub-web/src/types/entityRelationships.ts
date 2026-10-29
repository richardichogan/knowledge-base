export type RelationshipType = 'note' | 'diagram' | 'task';
export interface RelationshipScope { type: RelationshipType; id: string; elementId?: string }
export interface Relationship {
  key: string;
  type: string;
  id: string;
  title: string;
  href: string;
  elementId: string;
  elementTitle: string;
}
