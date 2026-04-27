/**
 * notes/MetadataBar.tsx — content type, taxonomy tag picker + GitHub push button.
 * Project field removed — taxonomy tags are now the organisational layer.
 */

import React from 'react';
import { ComboBox, Button, Tag } from '@carbon/react';
import { LogoGithub, Tag as TagIcon } from '@carbon/icons-react';
import { CONTENT_TYPE_OPTIONS, GITHUB_MODAL_HEADING } from './constants';
import type { ContentType, ContentTypeOption } from './constants';
import { TagPicker } from '../components/TagPicker';
import { useFlatTags } from '../hooks/useTaxonomy';

interface MetadataBarProps {
  contentType: ContentType;
  /** Taxonomy tag IDs applied to this note */
  taxonomyTagIds: string[];
  onContentTypeChange: (value: ContentType) => void;
  onTagIdsChange: (ids: string[]) => void;
  onPushToGitHub: () => void;
}

export const MetadataBar: React.FC<MetadataBarProps> = ({
  contentType,
  taxonomyTagIds,
  onContentTypeChange,
  onTagIdsChange,
  onPushToGitHub,
}) => {
  const selectedTypeOption = CONTENT_TYPE_OPTIONS.find((o) => o.id === contentType) ?? null;
  const flatTags = useFlatTags();
  const appliedTags = flatTags.filter((t) => taxonomyTagIds.includes(t.id));

  return (
    <>
      <div className="notes-meta-bar">
        {/* Content type selector */}
        <div className="notes-meta-field">
          <ComboBox<ContentTypeOption>
            id="note-content-type"
            items={CONTENT_TYPE_OPTIONS}
            itemToString={(item) => item?.label ?? ''}
            titleText="Content type"
            selectedItem={selectedTypeOption}
            onChange={({ selectedItem }) => {
              if (selectedItem !== null && selectedItem !== undefined) {
                onContentTypeChange(selectedItem.id);
              }
            }}
            size="sm"
          />
        </div>

        {/* Taxonomy tag picker */}
        <div className="notes-meta-field notes-meta-field--wide">
          <p className="notes-meta-label">Tags</p>
          <TagPicker
            selectedIds={taxonomyTagIds}
            onChange={onTagIdsChange}
            trigger={
              <button className="notes-tag-picker-trigger">
                <TagIcon size={14} />
                {appliedTags.length > 0 ? `${appliedTags.length} tag${appliedTags.length > 1 ? 's' : ''}` : 'Add tags…'}
              </button>
            }
          />
        </div>

        {/* Push to GitHub */}
        <div className="notes-meta-actions">
          <Button kind="ghost" size="sm" renderIcon={LogoGithub} iconDescription={GITHUB_MODAL_HEADING} onClick={onPushToGitHub}>
            Push to GitHub
          </Button>
        </div>
      </div>

      {/* Applied tag pills */}
      {appliedTags.length > 0 && (
        <div className="notes-tag-pills-row">
          {appliedTags.map((tag) => (
            <Tag
              key={tag.id}
              type="cool-gray"
              size="sm"
              filter
              onClose={() => { onTagIdsChange(taxonomyTagIds.filter((id) => id !== tag.id)); }}
            >
              {tag.name}
            </Tag>
          ))}
        </div>
      )}
    </>
  );
};
