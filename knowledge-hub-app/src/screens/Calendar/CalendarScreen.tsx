/**
 * CalendarScreen — displays upcoming/recent calendar events from the timeline.
 * Filters the timeline to graph-calendar source items.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useApiClient } from '../../services/ApiClientContext';
import type { ContentItemSummary } from '../../types';

const CALENDAR_SOURCE = 'graph-calendar';

/**
 * Renders a list of calendar events sourced from the backend timeline.
 */
export const CalendarScreen: React.FC = () => {
  const api = useApiClient();
  const [events, setEvents] = useState<ContentItemSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getTimeline({
        source: CALENDAR_SOURCE,
        pageSize: 50,
      });
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      setEvents(result.data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  if (loading && events.length === 0) {
    return (
      <View style={styles.centred}>
        <ActivityIndicator size="large" color="#0078D4" />
      </View>
    );
  }

  if (error !== null) {
    return (
      <View style={styles.centred}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={events}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={() => { void loadEvents(); }} />
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
          <Text style={styles.date}>
            {new Date(item.publishedAt).toLocaleString([], {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
          {item.summary !== '' && (
            <Text style={styles.summary} numberOfLines={2}>{item.summary}</Text>
          )}
        </View>
      )}
      ListEmptyComponent={
        <Text style={styles.empty}>No calendar events found.</Text>
      }
    />
  );
};

const styles = StyleSheet.create({
  list: { padding: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#0078D4',
    elevation: 1,
  },
  title: { fontSize: 15, fontWeight: '600', color: '#111', marginBottom: 4 },
  date: { fontSize: 12, color: '#0078D4', fontWeight: '500', marginBottom: 2 },
  summary: { fontSize: 12, color: '#555', marginTop: 4 },
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  error: { color: '#c00', textAlign: 'center', margin: 24 },
  empty: { textAlign: 'center', color: '#999', marginTop: 60 },
});
