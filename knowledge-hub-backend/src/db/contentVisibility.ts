/** Linked GitHub files are publication mirrors, not separate knowledge sources. */
export function canonicalContentSql(alias = 'content_items'): string {
  return `NOT EXISTS (
    SELECT 1 FROM note_github_publications publication
    WHERE ${alias}.source IN ('github-doc', 'github-content-store')
      AND lower(publication.repo) = lower(${alias}.metadata->>'repo')
      AND publication.path = ${alias}.metadata->>'path'
  )`;
}
