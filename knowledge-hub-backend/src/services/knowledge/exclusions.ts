export type ExclusionLoader = () => Promise<Set<string>>;

/** A record is excluded if ANY of its aliases (note id, mirror id, node id) is excluded. */
export function isExcluded(aliases: readonly string[], excluded: ReadonlySet<string>): boolean {
  return aliases.some(alias => excluded.has(alias));
}
