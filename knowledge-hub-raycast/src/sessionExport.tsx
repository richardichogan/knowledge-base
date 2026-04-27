/**
 * Raycast command: Export Claude Session
 *
 * Accepts a filename slug and full markdown content, then pushes the session
 * summary to Azure Blob Storage via the backend /api/capture/session endpoint.
 *
 * Filename must match: YYYY-MM-DD-topic-slug.md
 */

import {
  Action,
  ActionPanel,
  Form,
  showToast,
  Toast,
  useNavigation,
} from '@raycast/api';
import React, { useState } from 'react';
import { captureSession } from './api';

/** Pattern enforced by the backend: YYYY-MM-DD-topic-slug.md */
const FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

interface FormValues {
  filename: string;
  content: string;
}

/**
 * Main export — Raycast renders this as the "Export Claude Session" command.
 */
export default function SessionExportCommand(): React.JSX.Element {
  const { pop } = useNavigation();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(values: FormValues): Promise<void> {
    const filename = values.filename.trim();
    const content = values.content.trim();

    if (filename === '') {
      await showToast({ style: Toast.Style.Failure, title: 'Filename is required.' });
      return;
    }

    if (!FILENAME_PATTERN.test(filename)) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Invalid filename',
        message: 'Must match YYYY-MM-DD-topic-slug.md',
      });
      return;
    }

    if (content === '') {
      await showToast({ style: Toast.Style.Failure, title: 'Session content is required.' });
      return;
    }

    setLoading(true);
    const result = await captureSession({ filename, content });
    setLoading(false);

    if (result.success) {
      await showToast({ style: Toast.Style.Success, title: result.message });
      pop();
    } else {
      await showToast({ style: Toast.Style.Failure, title: result.message });
    }
  }

  return (
    <Form
      isLoading={loading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Export Session"
            onSubmit={(v) => { void handleSubmit(v as FormValues); }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="filename"
        title="Filename"
        placeholder="2025-06-15-my-topic-session.md"
        info="Must match YYYY-MM-DD-topic-slug.md"
      />
      <Form.TextArea
        id="content"
        title="Session Content"
        placeholder="Paste the full markdown session summary here…"
        enableMarkdown={false}
      />
    </Form>
  );
}
