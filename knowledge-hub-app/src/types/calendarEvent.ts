/**
 * Calendar event types — mirrors the backend CalendarEvent interface.
 */

export type CalendarSource = 'personal-m365' | 'ibm-m365';

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location?: string;
  organiser?: string;
  calendarSource: CalendarSource;
}
