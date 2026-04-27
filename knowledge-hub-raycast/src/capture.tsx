/**
 * Raycast command: Capture Task or Idea
 *
 * Presents a form to quickly create a task and send it to either
 * Microsoft To Do or GitHub Issues via the backend capture endpoint.
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
import { captureTask, type CaptureTaskInput } from './api';

type Destination = 'todo' | 'github-issue';

interface FormValues {
  title: string;
  body: string;
  destination: string;
  projectContext: string;
}

/**
 * Main export — Raycast renders this as the "Capture Task or Idea" command.
 */
export default function CaptureCommand(): React.JSX.Element {
  const { pop } = useNavigation();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(values: FormValues): Promise<void> {
    const title = values.title.trim();
    if (title === '') {
      await showToast({ style: Toast.Style.Failure, title: 'Title is required.' });
      return;
    }

    const destination = (values.destination as Destination) ?? 'todo';
    const input: CaptureTaskInput = {
      title,
      destination,
      ...(values.body.trim() !== '' && { body: values.body.trim() }),
      ...(values.projectContext.trim() !== '' && {
        projectContext: values.projectContext.trim(),
      }),
    };

    setLoading(true);
    const result = await captureTask(input);
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
          <Action.SubmitForm title="Create Task" onSubmit={(v) => { void handleSubmit(v as FormValues); }} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Title" placeholder="What needs doing?" />
      <Form.TextArea id="body" title="Notes" placeholder="Optional details…" />
      <Form.Dropdown id="destination" title="Send to" defaultValue="todo">
        <Form.Dropdown.Item value="todo" title="Microsoft To Do" />
        <Form.Dropdown.Item value="github-issue" title="GitHub Issues" />
      </Form.Dropdown>
      <Form.TextField
        id="projectContext"
        title="Project Context"
        placeholder="e.g. structara-ai (optional)"
      />
    </Form>
  );
}
