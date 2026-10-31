/**
 * features/plan/usePlanAthena.ts
 * Gives the floating Athena window the visible Plan tasks as page context,
 * and returns a helper to open Athena with a prompt about a task.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAthenaContext, type AthenaPageContext } from '../../context/AthenaContext';
import { api } from '../../services/api';
import { requireApiSuccess } from '../../services/apiError';
import { useProjects } from '../../services/useProjects';
import { localDateKey } from '../../utils/dateOnly';
import { planContextDetail } from './taskInsights';

export function usePlanAthena(filterProject: string, filterTag: string): (prompt: string) => void {
  const { setAthenaContext, openAthena, pageContext: currentContext } = useAthenaContext();
  const { projects } = useProjects();
  const { data } = useQuery({
    queryKey: ['tasks', filterProject],
    queryFn: async () => requireApiSuccess(await api.getTasks(filterProject ? { projectId: filterProject } : undefined)),
  });
  const pageContext = useMemo<AthenaPageContext>(() => {
    const items = data?.success === true ? data.data.items : [];
    const tasks = filterTag ? items.filter((t) => t.taxonomyTagIds.includes(filterTag)) : items;
    const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? id;
    return { type: 'task', title: 'Plan', id: 'plan', detail: planContextDetail(tasks, projectName, localDateKey(new Date())) };
  }, [data, filterTag, projects]);
  useEffect(() => {
    if (currentContext?.type === 'task' && currentContext.id !== 'plan') return;
    setAthenaContext(pageContext);
  }, [pageContext, currentContext, setAthenaContext]);
  useEffect(() => () => { setAthenaContext(null); }, [setAthenaContext]);
  return useCallback((prompt: string) => { openAthena(prompt, pageContext); }, [openAthena, pageContext]);
}
