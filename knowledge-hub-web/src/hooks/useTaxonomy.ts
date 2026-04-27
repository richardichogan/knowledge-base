/**
 * hooks/useTaxonomy.ts
 * React Query hooks for the tag taxonomy API.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { TaxonomyTag } from '../services/api';

export const TAXONOMY_KEY = ['taxonomy'] as const;
export const PENDING_KEY  = ['taxonomy-pending'] as const;

/** Full tag tree — parents with nested children array */
export function useTaxonomy() {
  return useQuery({
    queryKey: TAXONOMY_KEY,
    queryFn: async () => {
      const res = await api.getTaxonomy();
      return res.success ? res.data : [];
    },
    staleTime: 30_000,
  });
}

/** Flat list of all tags (parents + children) for pickers */
export function useFlatTags(): TaxonomyTag[] {
  const { data: tree = [] } = useTaxonomy();
  return tree.flatMap((parent) => [parent, ...(parent.children ?? [])]);
}

/**
 * Given a selected tag ID and the taxonomy tree, returns a Set containing
 * that ID plus all descendant IDs. This means filtering by a parent tag
 * automatically includes items tagged with any of its children.
 */
export function expandTagIds(selectedId: string, tree: TaxonomyTag[]): Set<string> {
  const ids = new Set<string>([selectedId]);
  for (const parent of tree) {
    if (parent.id === selectedId) {
      for (const child of parent.children ?? []) ids.add(child.id);
    } else {
      for (const child of parent.children ?? []) {
        if (child.id === selectedId) ids.add(child.id);
      }
    }
  }
  return ids;
}

/** Pending review queue */
export function usePendingTags() {
  return useQuery({
    queryKey: PENDING_KEY,
    queryFn: async () => {
      const res = await api.getPendingTags();
      return res.success ? res.data : [];
    },
    staleTime: 60_000,
  });
}

/** Create a tag — also invalidates the pending review queue */
export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; parentId?: string | null; colour?: string | null }) =>
      api.createTag(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TAXONOMY_KEY });
      void qc.invalidateQueries({ queryKey: PENDING_KEY });
    },
  });
}

/** Update a tag */
export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; name?: string; colour?: string | null }) =>
      api.updateTag(id, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TAXONOMY_KEY }),
  });
}

/** Delete a tag */
export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTag(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TAXONOMY_KEY });
      void qc.invalidateQueries({ queryKey: PENDING_KEY });
    },
  });
}

/** Tags on a specific note */
export function useNoteTags(noteId: string | null) {
  return useQuery({
    queryKey: ['note-tags', noteId],
    queryFn: async () => {
      if (!noteId) return [];
      const res = await api.getNoteTags(noteId);
      return res.success ? res.data : [];
    },
    enabled: noteId !== null,
    staleTime: 10_000,
  });
}

/** Replace tags on a note */
export function useSetNoteTags(noteId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagIds: string[]) => {
      if (!noteId) return Promise.reject(new Error('No note selected'));
      return api.setNoteTags(noteId, tagIds);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['note-tags', noteId] });
      void qc.invalidateQueries({ queryKey: ['notes-list'] });
    },
  });
}
