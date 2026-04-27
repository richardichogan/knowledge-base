/**
 * AIChatScreen — conversational AI interface using react-native-gifted-chat.
 *
 * The user types messages, they are sent to the backend /api/ai/chat endpoint,
 * and any proposed write actions are surfaced as confirmation banners.
 */

import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { GiftedChat, type IMessage } from 'react-native-gifted-chat';
import { useApiClient } from '../../services/ApiClientContext';
import type { WriteActionProposal } from '../../types';

const BOT_USER_ID = 'knowledge-hub-ai';
const HUMAN_USER_ID = 'user';

/** Minimal bot user descriptor required by GiftedChat. */
const BOT_USER = { _id: BOT_USER_ID, name: 'Knowledge Hub AI' } as const;

/**
 * Renders the AI chat tab. Messages are persisted in-memory per session.
 */
export const AIChatScreen: React.FC = () => {
  const api = useApiClient();
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<WriteActionProposal[]>([]);

  const appendBotMessage = useCallback((text: string): void => {
    const msg: IMessage = {
      _id: `bot-${Date.now().toString()}`,
      text,
      createdAt: new Date(),
      user: BOT_USER,
    };
    setMessages((prev) => GiftedChat.append(prev, [msg]));
  }, []);

  const handleSend = useCallback(
    async (outgoing: IMessage[]): Promise<void> => {
      const first = outgoing[0];
      if (first === undefined) return;

      setMessages((prev) => GiftedChat.append(prev, outgoing));

      try {
        const result = await api.chat({
          message: first.text,
          ...(sessionId !== null && { sessionId }),
        });

        if (!result.success) {
          appendBotMessage(`Error: ${result.error.message}`);
          return;
        }

        if (sessionId === null) {
          setSessionId(result.data.sessionId);
        }
        appendBotMessage(result.data.reply);

        if (result.data.pendingActions.length > 0) {
          setPendingActions(result.data.pendingActions);
        }
      } catch (err) {
        appendBotMessage(err instanceof Error ? err.message : 'Network error');
      }
    },
    [api, sessionId, appendBotMessage],
  );

  const handleConfirm = useCallback(
    async (proposalId: string): Promise<void> => {
      try {
        const result = await api.confirmAction(proposalId);
        if (result.success) {
          setPendingActions((prev) => prev.filter((p) => p.id !== proposalId));
          appendBotMessage('✅ Action confirmed and executed.');
        }
      } catch {
        appendBotMessage('Failed to confirm action.');
      }
    },
    [api, appendBotMessage],
  );

  const handleCancel = useCallback(
    async (proposalId: string): Promise<void> => {
      try {
        await api.cancelAction(proposalId);
        setPendingActions((prev) => prev.filter((p) => p.id !== proposalId));
      } catch {
        appendBotMessage('Failed to cancel action.');
      }
    },
    [api, appendBotMessage],
  );

  return (
    <View style={styles.container}>
      {pendingActions.map((action) => (
        <View key={action.id} style={styles.actionBanner}>
          <Text style={styles.actionText} numberOfLines={2}>
            {action.description}
          </Text>
          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={styles.confirmButton}
              onPress={() => { void handleConfirm(action.id); }}
            >
              <Text style={styles.buttonLabel}>Confirm</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => { void handleCancel(action.id); }}
            >
              <Text style={styles.buttonLabel}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
      <GiftedChat
        messages={messages}
        onSend={(msgs) => { void handleSend(msgs); }}
        user={{ _id: HUMAN_USER_ID }}
        renderUsernameOnMessage={false}
        placeholder="Ask your knowledge hub…"
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  actionBanner: {
    backgroundColor: '#FFF3CD',
    borderLeftWidth: 4,
    borderLeftColor: '#FFC107',
    marginHorizontal: 12,
    marginTop: 8,
    padding: 10,
    borderRadius: 6,
  },
  actionText: { fontSize: 13, color: '#333', marginBottom: 8 },
  actionButtons: { flexDirection: 'row', gap: 8 },
  confirmButton: {
    backgroundColor: '#0078D4',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 4,
  },
  cancelButton: {
    backgroundColor: '#888',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 4,
  },
  buttonLabel: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
