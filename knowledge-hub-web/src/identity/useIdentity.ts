import { useMemo } from 'react';
import { useTaxonomy } from '../hooks/useTaxonomy';
import { useProjects } from '../hooks/useProjects';
import type { TaxonomyTag } from '../services/api';
import { buildIdentityIndex } from './identityIndex';
import type { IdentityIndex } from './identityIndex';

export { buildIdentityIndex, identitiesFor, ctxTags } from './identityIndex';
export type { Identity, IdentityIndex, IdentityKind } from './identityIndex';

export function useIdentity(): IdentityIndex {
  const taxonomy = useTaxonomy();
  const projects = useProjects();
  const tree: TaxonomyTag[] | undefined = taxonomy.data;
  const list = projects.data;
  return useMemo(() => ({
    ...buildIdentityIndex(tree ?? [], list ?? []),
    ready: tree !== undefined && list !== undefined,
  }), [tree, list]);
}
