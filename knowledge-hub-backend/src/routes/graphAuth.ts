/**
 * graphAuth.ts
 *
 * OAuth2 routes for Microsoft Graph consent flow.
 * Unauthenticated — must be mounted BEFORE the API auth middleware.
 *
 * GET  /auth/graph          → redirects browser to Microsoft consent page
 * GET  /auth/graph/callback → exchanges code for tokens, saves refresh token to .env
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { env } from '../config/env.js';

export const graphAuthRouter = Router();

const SCOPES = [
  'Mail.Read',
  'Calendars.Read',
  'Tasks.ReadWrite',
  'offline_access',
].join(' ');

/** Step 1 — redirect to Microsoft consent page */
graphAuthRouter.get('/', (_req: Request, res: Response): void => {
  const tenantId = env.GRAPH_TENANT_ID ?? 'common';
  const clientId = env.GRAPH_CLIENT_ID ?? '';
  const redirectUri = env.GRAPH_REDIRECT_URI ?? 'http://localhost:3000/auth/graph/callback';

  const url = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('prompt', 'consent');

  res.redirect(url.toString());
});

/** Step 2 — exchange code for tokens, persist refresh token */
graphAuthRouter.get('/callback', (req: Request, res: Response): void => {
  const HTTP_BAD_REQUEST = 400;
  const HTTP_SERVER_ERROR = 500;
  const code = typeof req.query['code'] === 'string' ? req.query['code'] : null;
  const error = typeof req.query['error'] === 'string' ? req.query['error'] : null;
  const errorDesc = typeof req.query['error_description'] === 'string' ? req.query['error_description'] : null;

  if ((error !== null) || !code) {
    res.status(HTTP_BAD_REQUEST).send(`
      <h2>OAuth Error</h2>
      <p><strong>${error ?? 'No code received'}</strong></p>
      <p>${errorDesc ?? ''}</p>
    `);
    return;
  }

  const tenantId = env.GRAPH_TENANT_ID ?? 'common';
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID ?? '',
    client_secret: env.GRAPH_CLIENT_SECRET ?? '',
    code,
    redirect_uri: env.GRAPH_REDIRECT_URI ?? 'http://localhost:3000/auth/graph/callback',
    grant_type: 'authorization_code',
    scope: SCOPES,
  });

  void fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
    .then(async (tokenRes): Promise<void> => {
      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        res.status(HTTP_SERVER_ERROR).send(`<h2>Token exchange failed</h2><pre>${text}</pre>`);
        return;
      }

      const tokens = await tokenRes.json() as { refresh_token?: string; access_token: string };

      if (!tokens.refresh_token) {
        res.status(HTTP_SERVER_ERROR).send('<h2>No refresh token — ensure offline_access scope is granted.</h2>');
        return;
      }

      // Persist into .env
      const envPath = resolve(process.cwd(), '.env');
      let envContent = readFileSync(envPath, 'utf8');
      if (envContent.includes('GRAPH_REFRESH_TOKEN=')) {
        envContent = envContent.replace(/^GRAPH_REFRESH_TOKEN=.*$/m, `GRAPH_REFRESH_TOKEN=${tokens.refresh_token}`);
      } else {
        envContent += `\nGRAPH_REFRESH_TOKEN=${tokens.refresh_token}\n`;
      }
      writeFileSync(envPath, envContent, 'utf8');
      process.env['GRAPH_REFRESH_TOKEN'] = tokens.refresh_token;

      res.send(`
        <h2>✅ Microsoft Graph authorised successfully!</h2>
        <p>Refresh token saved to <code>.env</code>.</p>
        <p>Mail, Calendar and Tasks sync will now work for <strong>richard.hogan@themicrosoftcloudblog.com</strong>.</p>
        <p>You can close this tab.</p>
      `);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(HTTP_SERVER_ERROR).send(`<h2>Error</h2><pre>${message}</pre>`);
    });
});
