/**
 * Calendar event — unified representation from Microsoft Graph.
 */

export type CalendarSource = 'personal-m365' | 'ibm-work';

export interface CalendarEvent {
  id: string;
  source: CalendarSource;
  sourceId: string;
  subject: string;
  bodyPreview?: string;
  /** ISO 8601 UTC. */
  start: string;
  /** ISO 8601 UTC. */
  end: string;
  isAllDay: boolean;
  location?: string;
  isOnlineMeeting: boolean;
  onlineMeetingUrl?: string;
  organiser?: string;
  attendees: string[];
  /** ISO 8601. */
  createdDateTime: string;
  /** ISO 8601. */
  lastModifiedDateTime: string;
}
