/**
 * components/TagPanelTaxonomy.tsx
 * Taxonomy tab inside the TagPanel slide-over.
 * Shows parent/child tree with inline edit, add, and delete.
 */

import React, { useState } from 'react';
import { confirmDialog } from '../services/appDialogs';
import { Button, TextInput, InlineLoading, InlineNotification } from '@carbon/react';
import { ChevronDown, ChevronRight, Add, Edit, TrashCan } from '@carbon/icons-react';
import { useTaxonomy, useCreateTag, useUpdateTag, useDeleteTag } from '../hooks/useTaxonomy';
import type { TaxonomyTag } from '../services/api';
import { COLOUR_LABEL, IDENTITY_COLOURS, IDENTITY_PALETTE, IdentityMark, useIdentity } from '../identity';

/** Only top-level theme areas own a colour; projects set theirs on the project, topics inherit. */
const ownsColour = (tag: TaxonomyTag): boolean => tag.parentId == null && tag.role === 'concept' && !tag.projectId;

type EditingState = { id: string; name: string; colour: string } | null;
type AddingState  = { parentId: string | null } | null;

export const TagPanelTaxonomy: React.FC = () => {
  const { data: parents = [], isPending } = useTaxonomy();
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();
  const deleteTag = useDeleteTag();

  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [editing,  setEditing]    = useState<EditingState>(null);
  const [adding,   setAdding]     = useState<AddingState>(null);
  const [newName,  setNewName]    = useState('');
  const [newColour, setNewColour] = useState<string>(IDENTITY_PALETTE.purple);
  const [error, setError]         = useState<string | null>(null);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function saveEdit() {
    if (!editing) return;
    setError(null);
    try {
      await updateTag.mutateAsync({ id: editing.id, name: editing.name, ...(editing.colour ? { colour: editing.colour } : {}) });
      setEditing(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Update failed'); }
  }

  async function saveAdd() {
    if (!adding) return;
    setError(null);
    try {
      await createTag.mutateAsync({ name: newName.trim(), parentId: adding.parentId, ...(adding.parentId == null ? { colour: newColour } : {}) });
      setAdding(null);
      setNewName('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Create failed'); }
  }

  async function confirmDelete(tag: TaxonomyTag) {
    if (!await confirmDialog(`Delete tag "${tag.name}"? This cannot be undone.`, { title: 'Delete tag', confirmLabel: 'Delete', tone: 'danger' })) return;
    setError(null);
    try {
      await deleteTag.mutateAsync(tag.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Delete failed'); }
  }

  if (isPending) return <InlineLoading description="Loading taxonomy…" />;

  return (
    <div className="tag-panel-taxonomy">
      {error && <InlineNotification kind="error" title={error} lowContrast hideCloseButton />}

      {parents.map((parent) => (
        <div key={parent.id} className="tag-panel-group">
          {/* Parent row */}
          <div className="tag-panel-row tag-panel-row--parent">
            <button className="tag-panel-expand" onClick={() => { toggleExpand(parent.id); }}>
              {expanded.has(parent.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {editing?.id === parent.id ? (
              <TagEditInline
                name={editing.name}
                colour={editing.colour}
                onName={(v) => { setEditing({ ...editing, name: v }); }}
                onColour={(v) => { setEditing({ ...editing, colour: v }); }}
                onSave={() => { void saveEdit(); }}
                onCancel={() => { setEditing(null); }}
                saving={updateTag.isPending}
              />
            ) : (
              <TagRowDisplay tag={parent} onEdit={() => { setEditing({ id: parent.id, name: parent.name, colour: ownsColour(parent) ? (parent.colour ?? IDENTITY_PALETTE.purple) : '' }); }} onDelete={() => { void confirmDelete(parent); }} />
            )}
          </div>

          {/* Children */}
          {expanded.has(parent.id) && (
            <div className="tag-panel-children">
              {(parent.children ?? []).map((child) => (
                <div key={child.id} className="tag-panel-row tag-panel-row--child">
                  {editing?.id === child.id ? (
                    <TagEditInline
                      name={editing.name}
                      colour={editing.colour}
                      onName={(v) => { setEditing({ ...editing, name: v }); }}
                      onColour={(v) => { setEditing({ ...editing, colour: v }); }}
                      onSave={() => { void saveEdit(); }}
                      onCancel={() => { setEditing(null); }}
                      saving={updateTag.isPending}
                    />
                  ) : (
                    <TagRowDisplay tag={child} onEdit={() => { setEditing({ id: child.id, name: child.name, colour: '' }); }} onDelete={() => { void confirmDelete(child); }} />
                  )}
                </div>
              ))}

              {/* Add child */}
              {adding?.parentId === parent.id ? (
                <AddTagInline value={newName} colour="" onChange={setNewName} onColour={setNewColour} onSave={() => { void saveAdd(); }} onCancel={() => { setAdding(null); setNewName(''); }} saving={createTag.isPending} />
              ) : (
                <button className="tag-panel-add-child" onClick={() => { setAdding({ parentId: parent.id }); setNewName(''); }}>
                  <Add size={12} /> Add child tag
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Add parent tag */}
      {adding?.parentId === null ? (
        <AddTagInline value={newName} colour={newColour} onChange={setNewName} onColour={setNewColour} onSave={() => { void saveAdd(); }} onCancel={() => { setAdding(null); setNewName(''); }} saving={createTag.isPending} />
      ) : (
        <Button kind="ghost" size="sm" renderIcon={Add} iconDescription="Add parent tag" onClick={() => { setAdding({ parentId: null }); setNewName(''); }}>
          Add parent tag
        </Button>
      )}
    </div>
  );
};

const TagRowDisplay: React.FC<{ tag: TaxonomyTag; onEdit: () => void; onDelete: () => void }> = ({ tag, onEdit, onDelete }) => {
  const identity = useIdentity().byTagId(tag.id);
  return (
    <div className="tag-panel-row-content">
      <span className="tag-panel-mark"><IdentityMark identity={identity} size={12} /></span>
      <span className="tag-panel-name">{tag.name}</span>
      {tag.projectId && <span className="tag-panel-note">Project</span>}
      <span className="tag-panel-count">{tag.usageCount}</span>
      <button className="tag-panel-action" onClick={onEdit} aria-label="Edit"><Edit size={14} /></button>
      <button className="tag-panel-action tag-panel-action--danger" onClick={onDelete} aria-label="Delete"><TrashCan size={14} /></button>
    </div>
  );
};

/** Palette swatches; an empty value means the tag does not own a colour. */
const ColourSwatches: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  if (!value) return null;
  return (
    <div className="tag-panel-swatches" role="radiogroup" aria-label="Area colour">
      {IDENTITY_COLOURS.map((key) => {
        const hex = IDENTITY_PALETTE[key];
        const active = value.toLowerCase() === hex.toLowerCase();
        return (
          <button key={key} type="button" role="radio" aria-checked={active} aria-label={COLOUR_LABEL[key]} title={COLOUR_LABEL[key]}
            className={`proj-swatch tag-panel-swatch-option${active ? ' proj-swatch--active' : ''}`}
            style={{ '--kh-id': hex } as React.CSSProperties}
            onClick={() => { onChange(hex); }} />
        );
      })}
    </div>
  );
};

const TagEditInline: React.FC<{
  name: string; colour: string; saving: boolean;
  onName: (v: string) => void; onColour: (v: string) => void;
  onSave: () => void; onCancel: () => void;
}> = ({ name, colour, saving, onName, onColour, onSave, onCancel }) => (
  <div className="tag-panel-edit-block">
    <div className="tag-panel-edit-row">
      <TextInput id="tag-edit-name" labelText="" hideLabel size="sm" value={name} onChange={(e) => { onName(e.target.value); }} />
      <Button kind="primary" size="sm" onClick={onSave} disabled={saving}>Save</Button>
      <Button kind="ghost" size="sm" onClick={onCancel}>Cancel</Button>
    </div>
    <ColourSwatches value={colour} onChange={onColour} />
  </div>
);

const AddTagInline: React.FC<{
  value: string; colour: string; saving: boolean;
  onChange: (v: string) => void; onColour: (v: string) => void;
  onSave: () => void; onCancel: () => void;
}> = ({ value, colour, saving, onChange, onColour, onSave, onCancel }) => (
  <div className="tag-panel-edit-block">
    <div className="tag-panel-edit-row">
      <TextInput id="tag-add-name" labelText="" hideLabel size="sm" placeholder="Tag name…" value={value} onChange={(e) => { onChange(e.target.value); }} />
      <Button kind="primary" size="sm" onClick={onSave} disabled={saving || value.trim() === ''}>Add</Button>
      <Button kind="ghost" size="sm" onClick={onCancel}>Cancel</Button>
    </div>
    <ColourSwatches value={colour} onChange={onColour} />
  </div>
);
