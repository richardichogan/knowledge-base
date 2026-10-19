import type { ParkingSelection } from '../../types/discover';

export function hasParkingDestination(selection: ParkingSelection): boolean {
  return selection.newsletter || selection.podcast;
}

export function parkingLabel(selection: ParkingSelection): string {
  if (selection.newsletter && selection.podcast) return 'Newsletter and podcast';
  if (selection.newsletter) return 'Newsletter';
  return selection.podcast ? 'Podcast' : 'Choose newsletter, podcast or both';
}
