/**
 * TasksScreen — create tasks to Microsoft To Do or GitHub Issues.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useApiClient } from '../../services/ApiClientContext';
import type { TaskDestination } from '../../types';

/**
 * Simple form to capture a new task and route it to To Do or GitHub Issues.
 */
export const TasksScreen: React.FC = () => {
  const api = useApiClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [useGitHub, setUseGitHub] = useState(false);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const destination: TaskDestination = useGitHub ? 'github-issue' : 'todo';

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (title.trim() === '') {
      setFeedback({ ok: false, msg: 'Title is required.' });
      return;
    }
    setLoading(true);
    setFeedback(null);
    try {
      const result = await api.createTask({
        title: title.trim(),
        ...(body.trim() !== '' && { body: body.trim() }),
        destination,
      });
      if (!result.success) {
        setFeedback({ ok: false, msg: result.error.message });
        return;
      }
      setFeedback({ ok: true, msg: `Task created in ${destination}.` });
      setTitle('');
      setBody('');
    } catch (err) {
      setFeedback({ ok: false, msg: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setLoading(false);
    }
  }, [api, title, body, destination]);

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Title *</Text>
      <TextInput
        style={styles.input}
        placeholder="What needs doing?"
        value={title}
        onChangeText={setTitle}
      />

      <Text style={styles.label}>Notes</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        placeholder="Optional details…"
        value={body}
        onChangeText={setBody}
        multiline
        numberOfLines={4}
      />

      <View style={styles.toggle}>
        <Text style={styles.toggleLabel}>Send to GitHub Issues</Text>
        <Switch value={useGitHub} onValueChange={setUseGitHub} />
      </View>
      <Text style={styles.destination}>
        Will be sent to: <Text style={styles.destinationValue}>{destination}</Text>
      </Text>

      {feedback !== null && (
        <Text style={feedback.ok ? styles.success : styles.error}>{feedback.msg}</Text>
      )}

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={() => { void handleSubmit(); }}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonLabel}>Create Task</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f5f5f5', flexGrow: 1 },
  label: { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 4, marginTop: 12 },
  input: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    padding: 10,
    fontSize: 15,
  },
  multiline: { height: 100, textAlignVertical: 'top' },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  toggleLabel: { fontSize: 15, color: '#333' },
  destination: { fontSize: 12, color: '#666', marginTop: 4 },
  destinationValue: { fontWeight: '700', color: '#0078D4' },
  success: { color: '#107C10', marginTop: 12, fontWeight: '600' },
  error: { color: '#c00', marginTop: 12 },
  button: {
    backgroundColor: '#0078D4',
    marginTop: 24,
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonLabel: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
