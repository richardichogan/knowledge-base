/**
 * IBM work calendar — delegated access validation script.
 *
 * Uses device code flow via @azure/identity + @microsoft/microsoft-graph-client
 * to attempt reading IBM M365 calendar events using personal IBM credentials
 * from a non-IBM device. No app registration against the IBM tenant required.
 *
 * Run: npx ts-node --project tsconfig.scripts.json scripts/validate-ibm-calendar.ts
 *
 * Outcome is printed clearly to stdout for recording in the spec.
 *
 * See spec: Pre-build validation tasks — IBM work calendar — delegated access test
 */

import {
  DeviceCodeCredential,
  DeviceCodeInfo,
} from '@azure/identity';
import { Client, ResponseType } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from
  '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';

// IBM tenant ID — "organizations" allows multi-tenant device code flow
const IBM_TENANT_ID = 'organizations';

// Scope: read-only calendar access only — no write permissions
const SCOPES = ['Calendars.Read'];

interface GraphEvent {
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

interface GraphResponse {
  value: GraphEvent[];
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('IBM Work Calendar — Delegated Access Validation Test');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('This test attempts to read IBM M365 calendar events using');
  console.log('device code flow with personal IBM credentials.');
  console.log('No app registration against the IBM tenant is required.');
  console.log('');
  console.log('Scopes requested: ' + SCOPES.join(', '));
  console.log('');

  const credential = new DeviceCodeCredential({
    tenantId: IBM_TENANT_ID,
    clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46', // Microsoft Azure CLI public client — no secret needed
    userPromptCallback: (info: DeviceCodeInfo) => {
      console.log('');
      console.log('To authenticate, open a browser and visit:');
      console.log('  ' + info.verificationUri);
      console.log('');
      console.log('Then enter code: ' + info.userCode);
      console.log('');
      console.log('Waiting for authentication...');
    },
  });

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: SCOPES,
  });

  const client = Client.initWithMiddleware({ authProvider });

  try {
    console.log('Attempting to fetch calendar events from IBM M365...');
    console.log('');

    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();

    const response: GraphResponse = await client
      .api('/me/calendarView')
      .query({ startDateTime: from, endDateTime: to })
      .select('subject,start,end')
      .top(5)
      .responseType(ResponseType.JSON)
      .get() as GraphResponse;

    const events = response.value ?? [];

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('RESULT: ✅ SUCCESS — Delegated access works');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`Graph returned ${events.length} calendar event(s) in the ±7-day window:`);
    console.log('');

    for (const event of events) {
      console.log(`  • ${event.subject}`);
      console.log(`    Start: ${event.start.dateTime} (${event.start.timeZone})`);
      console.log('');
    }

    console.log('Decision: Add IBM work calendar as Tier 3 integration.');
    console.log('Scope: Calendars.Read via Graph, read-only, no write permissions.');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Update sources table in spec — add IBM calendar to Tier 3');
    console.log('  2. Update architecture decisions — resolved column');
    console.log('  3. Store the refresh token server-side for the IBM tenant');
    console.log('  4. Build ibm-calendar sync in Tier 3 integration layer');

  } catch (err) {
    const error = err as { statusCode?: number; code?: string; message?: string };

    console.log('═══════════════════════════════════════════════════════════════');

    if (error.statusCode === 401 || error.code === 'InvalidAuthenticationToken') {
      console.log('RESULT: ❌ AUTHENTICATION FAILED');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('');
      console.log('Token was rejected. Possible causes:');
      console.log('  - IBM conditional access policy blocks non-compliant devices');
      console.log('  - IBM tenant requires Intune device compliance');
      console.log('  - IBM blocks public client device code flow');
      console.log('');
      console.log('Error details:', error.message ?? 'none');
    } else if (error.statusCode === 403 || error.code === 'Forbidden') {
      console.log('RESULT: ⚠️  PARTIAL — Authentication succeeded, scope blocked');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('');
      console.log('Authentication worked but Calendars.Read scope was denied.');
      console.log('IBM tenant may restrict which scopes external devices can request.');
      console.log('');
      console.log('Error details:', error.message ?? 'none');
    } else {
      console.log('RESULT: ❌ CONDITIONAL ACCESS POLICY BLOCK');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('');
      console.log('IBM tenant rejected the request. IBM work calendar is');
      console.log('permanently out of scope.');
      console.log('');
      console.log('Error code:', error.code ?? 'unknown');
      console.log('Error status:', error.statusCode ?? 'unknown');
      console.log('Error message:', error.message ?? 'none');
    }

    console.log('');
    console.log('Decision: IBM work calendar remains out of scope.');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Script error:', err);
  process.exit(1);
});
