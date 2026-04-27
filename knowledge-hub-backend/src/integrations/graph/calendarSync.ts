import type { Pool } from 'pg';
import { getGraphClient } from './graphClient.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import type { ContentItem } from '../../types/contentItem.js';
import type { CalendarEvent } from '../../types/calendarEvent.js';

interface GraphEvent {
  id: string;
  subject: string;
  bodyPreview: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  location?: { displayName: string };
  isOnlineMeeting: boolean;
  onlineMeetingUrl?: string;
  organizer?: { emailAddress: { name: string } };
  attendees: Array<{ emailAddress: { name: string } }>;
  createdDateTime: string;
  lastModifiedDateTime: string;
}

/**
 * Syncs personal M365 calendar events into the content index.
 * Read-only. Calendars.Read scope.
 */
export async function syncCalendarEvents(
  db: Pool,
): Promise<{ indexed: number; errors: number }> {
  const client = getGraphClient();
  let indexed = 0;
  let errors = 0;

  // Fetch events from 30 days ago to 90 days ahead
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
  const to = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString();

  try {
    for await (const events of client.paginate<GraphEvent>('/me/calendarView', {
      startDateTime: from,
      endDateTime: to,
      $top: '50',
      $select: [
        'id', 'subject', 'bodyPreview', 'start', 'end', 'isAllDay',
        'location', 'isOnlineMeeting', 'onlineMeetingUrl',
        'organizer', 'attendees', 'createdDateTime', 'lastModifiedDateTime',
      ].join(','),
    })) {
      for (const event of events) {
        const item = eventToContentItem(event);
        await upsertContentItem(db, item);
        indexed++;
      }
    }
  } catch (err) {
    errors++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Graph calendar] Sync failed: ${message}`);
  }

  await upsertSyncState(db, 'graph-calendar', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `Calendar sync error` : null,
  });

  return { indexed, errors };
}

function eventToContentItem(event: GraphEvent): Omit<ContentItem, 'id' | 'indexedAt'> {
  const startIso = new Date(event.start.dateTime + 'Z').toISOString();
  const endIso = new Date(event.end.dateTime + 'Z').toISOString();

  const calEvent: CalendarEvent = {
    id: '',
    source: 'personal-m365',
    sourceId: event.id,
    subject: event.subject,
    bodyPreview: event.bodyPreview,
    start: startIso,
    end: endIso,
    isAllDay: event.isAllDay,
    isOnlineMeeting: event.isOnlineMeeting,
    attendees: event.attendees.map((a) => a.emailAddress.name),
    createdDateTime: new Date(event.createdDateTime).toISOString(),
    lastModifiedDateTime: new Date(event.lastModifiedDateTime).toISOString(),
    ...(event.location?.displayName !== undefined && { location: event.location.displayName }),
    ...(event.onlineMeetingUrl !== undefined && { onlineMeetingUrl: event.onlineMeetingUrl }),
    ...(event.organizer?.emailAddress.name !== undefined && { organiser: event.organizer.emailAddress.name }),
  };

  return {
    source: 'graph-calendar',
    sourceId: event.id,
    title: event.subject,
    summary: `Calendar: ${event.subject} at ${startIso}`,
    body: event.bodyPreview,
    publishedAt: startIso,
    projectContext: 'personal',
    metadata: calEvent as unknown as Record<string, unknown>,
    tags: [],
  };
}
