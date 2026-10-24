import { env } from '../../config/env.js';
import { HTTP_STATUS } from '../../config/constants.js';
import { IntegrationError, ValidationError } from '../../types/errors.js';

export const LINKEDIN_POST_LIMIT = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CARD_TITLE_CHARS = 200;
const PAYLOAD_TOO_LARGE_STATUS = 413;
const RATE_LIMITED_STATUS = 429;
const DEFINITE_REJECTIONS = new Set<number>([
  HTTP_STATUS.BAD_REQUEST, HTTP_STATUS.UNAUTHORISED, HTTP_STATUS.FORBIDDEN, HTTP_STATUS.NOT_FOUND,
  PAYLOAD_TOO_LARGE_STATUS, HTTP_STATUS.UNPROCESSABLE, RATE_LIMITED_STATUS,
]);
const MEMBER_ID = /^[a-zA-Z0-9_-]+$/;
const POST_URN = /^urn:li:(?:share|ugcPost):\d+$/;

export interface LinkedInMember { id: string; name: string }
export interface LinkedInLink { url: string; title: string }
export interface LinkedInPostResult { urn: string; url: string }

export class LinkedInPostUnconfirmedError extends IntegrationError {
  public constructor() {
    super('linkedin', 'The post may have been published. Check your LinkedIn profile; Athena will not send this article again automatically.');
    this.name = 'LinkedInPostUnconfirmedError';
  }
}

export function linkedinConfigured(): boolean {
  return Boolean(env.LINKEDIN_ACCESS_TOKEN);
}

export function composeLinkedInText(copy: string, url: string | null): string {
  if (!copy.trim()) throw new ValidationError('Write the post before sending it to LinkedIn.');
  if (url !== null) {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new ValidationError('The original article link is invalid.'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new ValidationError('The original article must have an HTTP or HTTPS link without credentials.');
    }
  }
  const text = [copy.trim(), url].filter(Boolean).join('\n\n');
  if (text.length > LINKEDIN_POST_LIMIT) {
    throw new ValidationError(`The post and link exceed LinkedIn's ${LINKEDIN_POST_LIMIT.toString()} character limit.`);
  }
  return text;
}

/** Resolve the token's own member, never a caller-supplied publishing identity. */
export async function getLinkedInMember(token = env.LINKEDIN_ACCESS_TOKEN): Promise<LinkedInMember> {
  if (!token) throw new IntegrationError('linkedin', 'Add a LinkedIn access token in Connections before posting.');
  let response: Response;
  try {
    response = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error',
    });
  } catch {
    throw new IntegrationError('linkedin', 'Could not verify the connected LinkedIn account. No post was sent.');
  }
  if (response.status === HTTP_STATUS.UNAUTHORISED || response.status === HTTP_STATUS.FORBIDDEN) {
    throw new IntegrationError('linkedin', 'LinkedIn rejected the access token. Renew it with openid, profile and w_member_social permissions in Connections. No post was sent.');
  }
  if (!response.ok) throw new IntegrationError('linkedin', `Account verification failed (HTTP ${response.status.toString()}). No post was sent.`);
  let member: unknown;
  try { member = await response.json(); }
  catch { throw new IntegrationError('linkedin', 'LinkedIn returned an invalid account response. No post was sent.'); }
  if (typeof member !== 'object' || member === null || !('sub' in member)
    || typeof member.sub !== 'string' || !MEMBER_ID.test(member.sub)
    || !('name' in member) || typeof member.name !== 'string' || !member.name.trim()) {
    throw new IntegrationError('linkedin', 'LinkedIn did not identify the connected member. Check the token has openid and profile permissions. No post was sent.');
  }
  return { id: member.sub, name: member.name.trim() };
}

/** One publish attempt only: uncertain outcomes must never be retried automatically. */
export async function postToLinkedIn(copy: string, link: LinkedInLink | null, expectedMemberId: string): Promise<LinkedInPostResult> {
  const text = composeLinkedInText(copy, link?.url ?? null);
  const token = env.LINKEDIN_ACCESS_TOKEN;
  const member = await getLinkedInMember(token);
  if (member.id !== expectedMemberId) {
    throw new ValidationError('The connected LinkedIn account changed. Review the account and confirm the post again.');
  }
  let response: Response;
  try {
    response = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
      body: JSON.stringify({
        author: `urn:li:person:${member.id}`, lifecycleState: 'PUBLISHED',
        specificContent: { 'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text }, shareMediaCategory: link === null ? 'NONE' : 'ARTICLE',
          ...(link !== null && { media: [{ status: 'READY', originalUrl: link.url, title: { text: link.title.slice(0, CARD_TITLE_CHARS) } }] }),
        } },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
      }),
    });
  } catch {
    throw new LinkedInPostUnconfirmedError();
  }
  if (DEFINITE_REJECTIONS.has(response.status)) {
    const detail = response.status === HTTP_STATUS.UNAUTHORISED || response.status === HTTP_STATUS.FORBIDDEN
      ? 'Renew the token with w_member_social permission in Connections.'
      : 'Check the post and try again later.';
    throw new IntegrationError('linkedin', `LinkedIn rejected the post (HTTP ${response.status.toString()}). ${detail}`);
  }
  const urn = response.headers.get('x-restli-id');
  if (response.status !== HTTP_STATUS.CREATED || urn === null || !POST_URN.test(urn)) {
    throw new LinkedInPostUnconfirmedError();
  }
  return { urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
}
