/**
 * components/TagPicker.tsx
 * Reusable tag selector — searchable two-level tree.
 * Uses a portal so it works inside Carbon Modals without clipping.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronRight, Checkmark } from '@carbon/icons-react';
import { useTaxonomy } from '../hooks/useTaxonomy';
import type { TaxonomyTag } from '../services/api';

interface TagPickerProps {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  trigger: React.ReactNode;
}

export const TagPicker: React.FC<TagPickerProps> = ({ selectedIds, onChange, trigger }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; direction: 'up' | 'down' } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: parents = [] } = useTaxonomy();

  // Position the dropdown relative to the trigger via portal
  const updatePos = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const dropdownHeight = 320; // max-height from CSS
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    // Open upward if not enough room below, or if inside a modal (bottom half of screen)
    if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
      setPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, direction: 'up' });
    } else {
      setPos({ bottom: 0, top: rect.bottom + 4, left: rect.left, direction: 'down' });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open, updatePos]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  function toggle(id: string) {
    onChange(selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id]);
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const q = query.toLowerCase();
  const matchesQuery = (tag: TaxonomyTag) => tag.name.toLowerCase().includes(q);

  const filteredParents = parents
    .map((p) => ({
      ...p,
      children: (p.children ?? []).filter((c) => !q || matchesQuery(c)),
    }))
    .filter((p) => !q || matchesQuery(p) || p.children.length > 0);

  const dropdown = open && pos ? createPortal(
    <div
      className="tag-picker-dropdown"
      ref={dropdownRef}
      style={{
        position: 'fixed',
        left: pos.left,
        ...(pos.direction === 'up'
          ? { bottom: pos.bottom }
          : { top: pos.top }),
      }}
    >
      <div className="tag-picker-search">
        <Search size={14} />
        <input
          autoFocus
          placeholder="Search tags…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
        />
      </div>

      <div className="tag-picker-list">
        {filteredParents.length === 0 && (
          <p className="tag-picker-empty">No tags found</p>
        )}

        {filteredParents.map((parent) => {
          const isExpanded = expanded.has(parent.id) || q !== '';
          const hasChildren = parent.children.length > 0;
          const isSelected = selectedIds.includes(parent.id);
          return (
            <div key={parent.id} className="tag-picker-group">
              <div className="tag-picker-parent-row">
                {hasChildren ? (
                  <button
                    className={`tag-picker-chevron${isExpanded ? ' tag-picker-chevron--open' : ''}`}
                    onClick={() => { toggleExpand(parent.id); }}
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    <ChevronRight size={14} />
                  </button>
                ) : (
                  <span className="tag-picker-chevron-spacer" />
                )}
                <button
                  className={`tag-picker-item${isSelected ? ' tag-picker-item--selected' : ''}`}
                  onClick={() => { toggle(parent.id); }}
                >
                  {parent.colour && (
                    <span className="tag-picker-swatch" style={{ background: parent.colour }} />
                  )}
                  <span className="tag-picker-name">{parent.name}</span>
                  {isSelected && <Checkmark size={14} className="tag-picker-check" />}
                </button>
              </div>

              {isExpanded && parent.children.map((child) => {
                const childSelected = selectedIds.includes(child.id);
                return (
                  <button
                    key={child.id}
                    className={`tag-picker-item tag-picker-item--child${childSelected ? ' tag-picker-item--selected' : ''}`}
                    onClick={() => { toggle(child.id); }}
                  >
                    {child.colour && (
                      <span className="tag-picker-swatch" style={{ background: child.colour }} />
                    )}
                    <span className="tag-picker-name">{child.name}</span>
                    {childSelected && <Checkmark size={14} className="tag-picker-check" />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="tag-picker-root" ref={triggerRef}>
      <div onClick={() => { setOpen((v) => !v); }}>{trigger}</div>
      {dropdown}
    </div>
  );
};
