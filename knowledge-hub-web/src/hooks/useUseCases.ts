/**
 * hooks/useUseCases.ts
 * React Query hooks for the use cases API. Every mutation returns the updated detail,
 * which is written into the detail cache; the list is refetched for counts and stage.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import type { CreateUseCaseInput, HandoffInput, UseCaseDetail, UseCasePatch, UseCaseSourceRef } from '../types/useCases';

export const USE_CASES_KEY = ['use-cases'] as const;
export const keyForUseCase = (id: string) => ['use-cases', id] as const;

function store(qc: QueryClient, detail: UseCaseDetail): void {
  qc.setQueryData(keyForUseCase(detail.id), detail);
  void qc.invalidateQueries({ queryKey: USE_CASES_KEY, exact: true });
  void qc.invalidateQueries({ queryKey: ['today'] });
}

export function useUseCases() {
  return useQuery({
    queryKey: USE_CASES_KEY,
    queryFn: async () => requireApiData(await api.listUseCases()),
    staleTime: 30_000,
  });
}

export function useUseCase(id: string | null) {
  return useQuery({
    queryKey: keyForUseCase(id ?? ''),
    queryFn: async () => requireApiData(await api.getUseCase(id ?? '')),
    enabled: id !== null,
  });
}

export function useCreateUseCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateUseCaseInput) => requireApiData(await api.createUseCase(input)),
    onSuccess: (detail) => store(qc, detail),
  });
}

export function useUpdateUseCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UseCasePatch }) => requireApiData(await api.updateUseCase(id, patch)),
    onSuccess: (detail) => store(qc, detail),
  });
}

export function useDeleteUseCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => { await api.deleteUseCase(id); },
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: keyForUseCase(id) });
      void qc.invalidateQueries({ queryKey: USE_CASES_KEY, exact: true });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useAddUseCaseSources() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, sources }: { id: string; sources: UseCaseSourceRef[] }) => requireApiData(await api.addUseCaseSources(id, sources)),
    onSuccess: (detail) => store(qc, detail),
  });
}

export function useRemoveUseCaseSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ref }: { id: string; ref: UseCaseSourceRef }) => requireApiData(await api.removeUseCaseSource(id, ref)),
    onSuccess: (detail) => store(qc, detail),
  });
}

export function useAddUseCaseLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, url, title }: { id: string; url: string; title?: string }) => requireApiData(await api.addUseCaseLink(id, url, title)),
    onSuccess: (detail) => store(qc, detail),
  });
}

export function useRemoveUseCaseLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, linkId }: { id: string; linkId: string }) => requireApiData(await api.removeUseCaseLink(id, linkId)),
    onSuccess: (detail) => store(qc, detail),
  });
}

export function useDraftUseCaseSpec() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, replace }: { id: string; replace: boolean }) => requireApiData(await api.draftUseCaseSpec(id, replace)),
    onSuccess: (result) => store(qc, result.useCase),
  });
}

export function useHandoffUseCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: HandoffInput }) => requireApiData(await api.handoffUseCase(id, input)),
    onSuccess: (result) => store(qc, result.useCase),
  });
}
