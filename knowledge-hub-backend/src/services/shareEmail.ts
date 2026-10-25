import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { Pool } from 'pg';
import { XMLValidator } from 'fast-xml-parser';
import { encryptConnectionValue, decryptConnectionValue } from './connectionCredentials.js';
import { ConflictError, IntegrationError, ValidationError } from '../types/errors.js';
import { inviteMuralRecipients, muralBoard } from './mural.js';
import { renderNoteEmail } from './noteEmail.js';

const CONFIG_KEY = 'integration:smtp2go:config';
export const SHARE_FROM = 'share@athena.themicrosoftcloudblog.com';
const HOST = 'mail-eu.smtp2go.com';
const PORT = 2525;
const TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 4_194_304;
const MAX_RECIPIENTS = 20;
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_SUBJECT_LENGTH = 200;
const MAX_SECRET_LENGTH = 8192;
const MAX_ADDRESS_LENGTH = 254;
const MAX_REQUEST_ID_LENGTH = 80;
const MAX_URL_LENGTH = 2048;
const MAX_FILENAME_LENGTH = 120;
const MAX_NOTE_TITLE_LENGTH = 500;
const MAX_NOTE_MARKDOWN_LENGTH = 200_000;
interface Config { username: string; password: string; replyTo: string }
export interface ShareEmailResult { accepted: number; rejected: number; muralInvited?: number }
interface ShareEmailStatus { configured: boolean; username: string; replyTo: string; from: string; host: string; port: number }
interface Attachment { filename: string; content: Buffer; contentType: string }
interface ValidatedEmail {
  requestId: string; recipients: string[]; subject: string; message: string; url: string; attachment: Attachment | undefined;
  muralAccess?: 'view' | 'edit';
  note?: { title: string; markdown: string };
}
type Store = Pick<Pool, 'query'>;
type SendMail = (options: nodemailer.SendMailOptions) => Promise<SMTPTransport.SentMessageInfo>;
function smtpFailure(error: unknown, detail: string): IntegrationError {
  const failure = new IntegrationError('smtp2go', detail);
  failure.cause = error;
  if (error && typeof error === 'object') {
    const diagnostics: Record<string, string | number> = {};
    for (const key of ['code', 'command', 'responseCode']) {
      const value: unknown = Reflect.get(error, key);
      if (typeof value === 'number' || (typeof value === 'string' && /^[A-Z0-9 _-]{1,40}$/i.test(value))) diagnostics[key] = value;
    }
    console.error('[smtp2go]', diagnostics);
  }
  return failure;
}
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Enter email sharing details.');
  return value as Record<string, unknown>;
}
function line(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw new ValidationError('Enter a valid single-line email setting or subject.');
  }
  return value.trim();
}
function email(value: unknown): string {
  const address = line(value, MAX_ADDRESS_LENGTH);
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i.test(address)) {
    throw new ValidationError('Enter email addresses without display names.');
  }
  return address;
}
async function readConfig(db: Store): Promise<Config | null> {
  const { rows } = await db.query<{ last_cursor: string }>('SELECT last_cursor FROM sync_state WHERE source = $1', [CONFIG_KEY]);
  return rows[0] ? JSON.parse(decryptConnectionValue(CONFIG_KEY, rows[0].last_cursor)) as Config : null;
}
export async function shareEmailStatus(db: Store): Promise<ShareEmailStatus> {
  const config = await readConfig(db);
  return { configured: config !== null, username: config?.username ?? 'athena.themicrosoftcloudblog.com',
    replyTo: config?.replyTo ?? '', from: SHARE_FROM, host: HOST, port: PORT };
}
export async function saveShareEmailConfig(db: Store, input: unknown): Promise<ShareEmailStatus> {
  const data = record(input);
  if (Object.keys(data).some(key => !['username', 'password', 'replyTo'].includes(key))) throw new ValidationError('Unknown email setting.');
  const username = line(data.username, MAX_ADDRESS_LENGTH);
  const previous = await readConfig(db);
  const password = data.password === '' ? previous?.password : line(data.password, MAX_SECRET_LENGTH);
  if (!password) throw new ValidationError('Enter the SMTP2GO password.');
  const replyTo = data.replyTo === '' ? '' : email(data.replyTo);
  const encrypted = encryptConnectionValue(CONFIG_KEY, JSON.stringify({ username, password, replyTo }));
  await db.query(`INSERT INTO sync_state (source, last_cursor, item_count, updated_at) VALUES ($1, $2, 0, NOW())
    ON CONFLICT (source) DO UPDATE SET last_cursor = EXCLUDED.last_cursor, updated_at = NOW()`, [CONFIG_KEY, encrypted]);
  return shareEmailStatus(db);
}
function transport(config: Config): nodemailer.Transporter<SMTPTransport.SentMessageInfo> {
  return nodemailer.createTransport({
    host: HOST, port: PORT, secure: false, requireTLS: true,
    auth: { user: config.username, pass: config.password },
    connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS,
    disableFileAccess: true, disableUrlAccess: true,
  });
}
export async function verifyShareEmailConfig(db: Store): Promise<{ verified: true }> {
  const config = await readConfig(db);
  if (!config) throw new ValidationError('Set up SMTP2GO in Sources / Integrations first.');
  try { await transport(config).verify(); }
  catch (error) { throw smtpFailure(error, 'Could not verify SMTP2GO authentication. Check the saved username/password and SMTP2GO status. No email was sent.'); }
  return { verified: true };
}

export function validateShareEmail(input: unknown): ValidatedEmail {
  const data = record(input);
  if (data.confirmed !== true) throw new ValidationError('Review and confirm the email before sending.');
  const requestId = line(data.requestId, MAX_REQUEST_ID_LENGTH);
  if (!/^[a-z0-9-]{16,80}$/i.test(requestId)) throw new ValidationError('Invalid send identifier. Reopen the email composer.');
  if (!Array.isArray(data.recipients) || data.recipients.length === 0 || data.recipients.length > MAX_RECIPIENTS) {
    throw new ValidationError(`Choose 1-${MAX_RECIPIENTS} recipients.`);
  }
  const recipients = [...new Set(data.recipients.map(email).map(value => value.toLowerCase()))];
  const subject = line(data.subject, MAX_SUBJECT_LENGTH);
  if (typeof data.message !== 'string' || data.message.length > MAX_MESSAGE_LENGTH || data.message.includes('\0')) throw new ValidationError('The message must be at most 10,000 characters.');
  let url = '';
  if (data.url !== undefined && data.url !== '') {
    const raw = line(data.url, MAX_URL_LENGTH);
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new ValidationError('Choose a Mural board or published GitHub note link.'); }
    if (parsed.hostname === 'app.mural.co') url = muralBoard(raw).url;
    else if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && !parsed.username && !parsed.password && !parsed.port
      && /^\/[\w.-]+\/[\w.-]+\/blob\/.+\.md$/i.test(parsed.pathname) && !parsed.search && !parsed.hash) url = parsed.href;
    else throw new ValidationError('Only individual Mural boards or GitHub Markdown file links can be shared.');
  }
  let attachment: Attachment | undefined;
  if (data.attachment !== undefined) {
    const file = record(data.attachment), filename = line(file.filename, MAX_FILENAME_LENGTH);
    if (!filename.toLowerCase().endsWith('.drawio') || /[\\/:*?"<>|]/.test(filename) || [...filename].some(c => c < ' ')) {
      throw new ValidationError('Attach a .drawio file with a simple filename.');
    }
    if (typeof file.xml !== 'string' || Buffer.byteLength(file.xml) > MAX_ATTACHMENT_BYTES || /<!DOCTYPE|<!ENTITY/i.test(file.xml)
      || !/^\s*(?:<\?xml[^?]*\?>\s*)?<mxfile[\s>]/.test(file.xml) || XMLValidator.validate(file.xml) !== true) {
      throw new ValidationError('Attach a valid draw.io XML file up to 4 MiB.');
    }
    attachment = { filename, content: Buffer.from(file.xml, 'utf8'), contentType: 'application/vnd.jgraph.mxfile' };
  }
  let note: ValidatedEmail['note'];
  if (data.note !== undefined) {
    const value = record(data.note);
    const title = line(value.title, MAX_NOTE_TITLE_LENGTH);
    if (typeof value.markdown !== 'string' || !value.markdown.trim() || value.markdown.length > MAX_NOTE_MARKDOWN_LENGTH
      || value.markdown.includes('\0')) throw new ValidationError('Include note text up to 200,000 characters.');
    note = { title, markdown: value.markdown };
  }
  if (!url && !attachment && !note) throw new ValidationError('Include note text, a Mural/GitHub link or draw.io attachment.');
  if (data.muralAccess !== undefined && (data.muralAccess !== 'view' && data.muralAccess !== 'edit'
    || !url.startsWith('https://app.mural.co/'))) throw new ValidationError('Choose View or Edit access for a Mural board only.');
  return { requestId, recipients, subject, message: data.message, url, attachment, ...(note ? { note } : {}),
    ...(data.muralAccess === 'view' || data.muralAccess === 'edit' ? { muralAccess: data.muralAccess } : {}) };
}

export async function sendShareEmail(db: Pool, userId: string, input: unknown, send?: SendMail): Promise<ShareEmailResult> {
  const data = validateShareEmail(input);
  const config = await readConfig(db);
  if (!config) throw new ValidationError('Set up SMTP2GO in Sources / Integrations first.');
  const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const key = `share-email:${createHash('sha256').update(userId).digest('hex')}:${data.requestId}`;
  const reserved = await db.query(`INSERT INTO sync_state (source, last_cursor, item_count, updated_at) VALUES ($1, $2, 0, NOW())
    ON CONFLICT (source) DO NOTHING`, [key, JSON.stringify({ fingerprint, state: 'sending' })]);
  if (reserved.rowCount !== 1) {
    const { rows } = await db.query<{ last_cursor: string }>('SELECT last_cursor FROM sync_state WHERE source = $1', [key]);
    const previous = record(JSON.parse(rows[0]?.last_cursor ?? '{}'));
    if (previous.fingerprint !== fingerprint || previous.state !== 'accepted') {
      throw new ConflictError('This share was already attempted or is still sending. Check SMTP2GO activity and, if requested, Mural invitations before composing another copy.', 'EMAIL_ALREADY_ATTEMPTED');
    }
    return { accepted: Number(previous.accepted), rejected: Number(previous.rejected),
      ...(typeof previous.muralInvited === 'number' ? { muralInvited: previous.muralInvited } : {}) };
  }
  let muralInvited: number | undefined;
  if (data.muralAccess) {
    try { muralInvited = await inviteMuralRecipients(db, data.url, data.recipients, data.muralAccess); }
    catch (error) {
      throw new IntegrationError('mural', `${error instanceof Error ? error.message : 'Mural invitations were not confirmed.'} No SMTP2GO sharing email was sent. Mural may have sent invitations; inspect the board before starting a new share. No automatic retry was made.`);
    }
  }
  const accessNotice = data.muralAccess
    ? `Mural ${data.muralAccess} invitations were requested separately. Accept your Mural invitation if prompted. Existing permissions and workspace policies still apply.`
    : data.url ? 'Links do not grant access to private boards or repositories.' : '';
  const text = [data.message, data.note?.markdown, data.url, data.attachment ? `Attached: ${data.attachment.filename}` : '',
    `Shared from Athena. ${accessNotice}`].filter(Boolean).join('\n\n');
  let result: SMTPTransport.SentMessageInfo;
  try {
    const sendMail: SendMail = send ?? ((options): Promise<SMTPTransport.SentMessageInfo> => transport(config).sendMail(options));
    result = await sendMail({
      from: { name: 'Athena', address: SHARE_FROM }, to: SHARE_FROM, bcc: data.recipients,
      envelope: { from: SHARE_FROM, to: data.recipients },
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
      subject: data.subject, text,
      html: `<div style="max-width:720px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#262626;background:#ffffff"><p>${escapeHtml(data.message).replace(/\r?\n/g, '<br>')}</p>${data.note ? renderNoteEmail(data.note.title, data.note.markdown) : ''}${data.url ? `<p><a href="${escapeHtml(data.url)}">Open shared content</a></p>` : ''}
        <p>${escapeHtml(data.attachment ? `Attached: ${data.attachment.filename}` : '')}</p>
        <p style="font-size:12px;color:#525252;border-top:1px solid #c6c6c6;padding-top:16px">Shared from Athena. ${escapeHtml(accessNotice)}</p></div>`,
      attachments: data.attachment ? [data.attachment] : [],
      disableFileAccess: true, disableUrlAccess: true,
      messageId: `<${createHash('sha256').update(key).digest('hex')}@athena.themicrosoftcloudblog.com>`,
    });
  } catch (error) {
    throw smtpFailure(error, `SMTP2GO did not confirm the send. Delivery may be uncertain; check SMTP2GO activity before sending another copy.${muralInvited !== undefined ? ' Mural invitations were already requested; they have not been revoked.' : ''} No automatic retry was made.`);
  }
  const outcome = { accepted: result.accepted.length, rejected: result.rejected.length,
    ...(muralInvited !== undefined ? { muralInvited } : {}) };
  try {
    await db.query('UPDATE sync_state SET last_cursor = $2, updated_at = NOW() WHERE source = $1',
      [key, JSON.stringify({ fingerprint, state: outcome.accepted > 0 ? 'accepted' : 'rejected', ...outcome })]);
  } catch {
    throw new IntegrationError('smtp2go', 'SMTP2GO responded, but Athena could not save the submission result. The email may already have been sent. Check SMTP2GO activity before composing another copy.');
  }
  if (outcome.accepted === 0) throw new IntegrationError('smtp2go', 'SMTP2GO accepted no recipients. Check SMTP2GO activity and sender verification.');
  return outcome;
}
