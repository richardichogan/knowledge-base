const MICROSOFT_TERMS = 'microsoft|msft|azure|copilot|m365|office 365|github|dynamics 365|power platform|power bi|microsoft fabric|entra|purview|intune|sentinel|sharepoint|nadella';
const MICROSOFT_PATTERN = new RegExp(`\\b(?:${MICROSOFT_TERMS})\\b`, 'i');
const MICROSOFT_SQL_PATTERN = `\\y(${MICROSOFT_TERMS})\\y`;

/** A Microsoft source or an explicit Microsoft connection in the article, not an invented editorial angle. */
export function isMicrosoftRelevant(candidate: { title: string; url: string; text?: string }): boolean {
  try {
    if (/(?:^|\.)(?:microsoft|azure|github|office)\.com$/i.test(new URL(candidate.url).hostname)) return true;
  } catch { /* Articles without a usable URL can still name Microsoft in their text. */ }
  return MICROSOFT_PATTERN.test(candidate.title) || MICROSOFT_PATTERN.test((candidate.text ?? '').slice(0, 2000));
}

/** Same gate for content_items queries; alias must be a caller-owned SQL identifier. */
export function microsoftRelevanceSql(alias: string): string {
  return `(${alias}.title ~* '${MICROSOFT_SQL_PATTERN}'
    OR COALESCE(${alias}.url, '') ~* '^https?://([a-z0-9-]+\\.)*(microsoft|azure|github|office)\\.com(:[0-9]+)?([/?#]|$)'
    OR LEFT(COALESCE(${alias}.body, ''), 2000) ~* '${MICROSOFT_SQL_PATTERN}')`;
}
