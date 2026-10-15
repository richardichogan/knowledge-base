export interface EmailAccountConnection {
  id: string;
  email: string;
  provider: 'Microsoft 365' | 'Outlook.com' | 'Gmail';
  status: 'configured' | 'not-connected';
  detail: string;
}

/** Configuration is not proof of a successful sign-in or mailbox sync. Never return credentials. */
export function emailAccountConnections(allianceUpn: string | undefined, rawAccounts: string | undefined): EmailAccountConnection[] {
  let accounts: unknown = [];
  if (rawAccounts) {
    accounts = JSON.parse(rawAccounts);
  }
  if (!Array.isArray(accounts)) throw new Error('EMAIL_ACCOUNTS must be an array');
  const configured = new Set<string>();
  for (const value of accounts) {
    if (!value || typeof value !== 'object') throw new Error('EMAIL_ACCOUNTS contains an invalid account');
    const account = value as Record<string, unknown>;
    if (typeof account.email !== 'string') throw new Error('EMAIL_ACCOUNTS contains an account without an email address');
    if (account.host && account.user && account.pass) configured.add(account.email.trim().toLowerCase());
  }
  const requested = [
    { id: 'alliance', email: allianceUpn?.trim() || 'Richard.i.Hogan@ibmalliance.onmicrosoft.com', provider: 'Microsoft 365' as const,
      detail: 'Mailbox authorisation is required for the IBM Alliance tenant. The existing Alliance OneDrive sign-in does not grant mail access.' },
    { id: 'hotmail', email: 'richard_hogan@hotmail.co.uk', provider: 'Outlook.com' as const,
      detail: 'This personal Microsoft account needs its own mailbox authorisation, separate from the blog Microsoft 365 account.' },
    { id: 'gmail', email: 'richardichogan@gmail.com', provider: 'Gmail' as const,
      detail: 'Google mailbox authorisation is required. Microsoft sign-in does not connect Gmail.' },
  ];
  return requested.map((account) => ({
    ...account,
    status: configured.has(account.email.toLowerCase()) ? 'configured' : 'not-connected',
    detail: configured.has(account.email.toLowerCase())
      ? 'IMAP configuration is present. See source sync results for successful imports; configuration alone does not verify access.'
      : account.detail,
  }));
}
