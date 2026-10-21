export interface ShareEmailStatus {
  configured: boolean;
  username: string;
  replyTo: string;
  from: string;
  host: string;
  port: number;
}
export interface ShareEmailContent {
  title: string;
  url?: string;
  attachment?: { filename: string; xml: string };
}
export interface ShareEmailInput {
  requestId: string;
  confirmed: true;
  recipients: string[];
  subject: string;
  message: string;
  url?: string;
  attachment?: { filename: string; xml: string };
  muralAccess?: 'view' | 'edit';
}
export interface ShareEmailResult { accepted: number; rejected: number; muralInvited?: number }
