/**
 * SearchScreen — full-text search over synced content.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useApiClient } from '../../services/ApiClientContext';
import type { ContentItemSummary } from '../../types';

/**
 * Renders a search bar and a list of matching content items.
 */
export const SearchScreen: React.FC = () => {
  const api = useApiClient();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContentItemSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(
    async (text: string): Promise<void> => {
      setQuery(text);
      if (text.trim().length < 2) {
        setResults([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await api.search({ q: text });
        if (!result.success) {
          setError(result.error.message);
          return;
        }
        setResults(result.data.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Search your knowledge…"
        value={query}
        onChangeText={(text) => { void handleSearch(text); }}
        clearButtonMode="while-editing"
        autoCorrect={false}
      />
      {loading && <ActivityIndicator style={styles.spinner} />}
      {error !== null && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.source}>{item.source}</Text>
            <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
            <Text style={styles.summary} numberOfLines={2}>{item.summary}</Text>
          </View>
        )}
        ListEmptyComponent={
          !loading && query.length >= 2 ? (
            <Text style={styles.empty}>No results for "{query}"</Text>
          ) : null
        }
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  input: {
    margin: 12,
    padding: 10,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    fontSize: 15,
  },
  spinner: { marginTop: 8 },
  error: { color: '#c00', textAlign: 'center', margin: 12 },
  card: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 8,
    padding: 12,
    elevation: 1,
  },
  source: { fontSize: 11, color: '#666', textTransform: 'uppercase', marginBottom: 2 },
  title: { fontSize: 15, fontWeight: '600', color: '#111', marginBottom: 4 },
  summary: { fontSize: 13, color: '#444' },
  empty: { textAlign: 'center', color: '#999', marginTop: 40 },
});
