/**
 * components/discover/DiscoverActions.tsx
 * Shared Save / Blog / Archive action buttons for Discover items in to-review state.
 * Extracted from DiscoverPage so the Today ranked list can reuse them without
 * duplicating the button markup and handler logic.
 */

import React from 'react';
import { Bookmark, Edit, Archive } from '@carbon/icons-react';
import type { DiscoverWorkflowState } from '../../services/api';

/** Props for the DiscoverActions component. */
export interface DiscoverActionsProps {
  /** ID of the DiscoverItem being actioned. */
  itemId: string;
  /** Called with the new workflow state when a button is clicked. */
  onStateChange: (id: string, state: DiscoverWorkflowState) => void;
  /** Disables all buttons while a mutation is in flight. */
  isUpdating: boolean;
}

/**
 * Renders the three workflow action buttons (Save, Blog, Archive) for a
 * Discover item that is currently in the "to-review" state.
 */
export const DiscoverActions: React.FC<DiscoverActionsProps> = ({
  itemId,
  onStateChange,
  isUpdating,
}) => (
  <>
    <button
      className="dc-action dc-action--save"
      onClick={() => { onStateChange(itemId, 'saved'); }}
      disabled={isUpdating}
    >
      <Bookmark size={14} /> Save
    </button>
    <button
      className="dc-action dc-action--blog"
      onClick={() => { onStateChange(itemId, 'blog'); }}
      disabled={isUpdating}
    >
      <Edit size={14} /> Blog
    </button>
    <button
      className="dc-action dc-action--archive"
      onClick={() => { onStateChange(itemId, 'archived'); }}
      disabled={isUpdating}
    >
      <Archive size={14} /> Archive
    </button>
  </>
);
