/**
 * TimelineScreen — paginated feed of all synced content items.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useApiClient } from '../../services/ApiClientContext';
import type { ContentItemSummary } from '../../types';

const PAGE_SIZE = 20;

interface TimelineItemProps {
  item: ContentItemSummary;
}

const TimelineItem: React.FC<TimelineItemProps> = ({ item }) => (
  <View style={styles.card}>
    <Text style={styles.source}>{item.source}</Text>
    <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
    <Text style={styles.summary} numberOfLines={3}>{item.summary}</Text>
    <Text style={styles.date}>
      {new Date(item.publishedAt).toLocaleDateString()}
    </Text>
  </View>
);

/**
 * Renders a reverse-chronological feed of content items from the backend.
 */
export const TimelineScreen: React.FC = () => {
  const api = useApiClient();
  const [items, setItems] = useState<ContentItemSummary[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (pageNum: number): Promise<void> => {
      if (loading) return;
      setLoading(true);
      setError(null);
      try {
        const result = await api.getTimeline({ page: pageNum, pageSize: PAGE_SIZE });
        if (!result.success) {
          setError(result.error.message);
          return;
        }
        setItems((prev) =>
          pageNum === 1 ? result.data.items : [...prev, ...result.data.items],
        );
        setHasMore(result.data.hasMore);
        setPage(pageNum);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setLoading(false);
      }
    },
    [api, loading],
  );

  useEffect(() => {
    void loadPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEndReached = useCallback((): void => {
    if (hasMore && !loading) {
      void loadPage(page + 1);
    }
  }, [hasMore, loading, page, loadPage]);

  const handleRefresh = useCallback((): void => {
    void loadPage(1);
  }, [loadPage]);

  if (error !== null) {
    return (
      <View style={styles.centred}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity onPress={handleRefresh} style={styles.retryButton}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <TimelineItem item={item} />}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.4}
      onRefresh={handleRefresh}
      refreshing={loading && page === 1}
      ListFooterComponent={
        loading && page > 1 ? <ActivityIndicator style={styles.footer} /> : null
      }
      contentContainerStyle={styles.list}
    />
  );
};

const styles = StyleSheet.create({
  list: { padding: 12 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  source: { fontSize: 11, color: '#666', textTransform: 'uppercase', marginBottom: 4 },
  title: { fontSize: 16, fontWeight: '600', color: '#111', marginBottom: 4 },
  summary: { fontSize: 13, color: '#444', marginBottom: 6 },
  date: { fontSize: 11, color: '#999' },
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: '#c00', marginBottom: 12, textAlign: 'center' },
  retryButton: {
    backgroundColor: '#0078D4',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 6,
  },
  retryText: { color: '#fff', fontWeight: '600' },
  footer: { marginVertical: 16 },
});
