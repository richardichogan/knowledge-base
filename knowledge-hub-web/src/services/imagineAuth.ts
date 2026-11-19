import { acquireRegisteredIdToken } from './auth';

// Public identifiers from Imagine's participant MSAL configuration (not credentials).
const CLIENT_ID = 'aa306537-2615-4382-b97e-a03975a62304';
const TENANT_ID = '740bc3aa-5daf-42f6-939a-b2d007a60d26';

export function acquireImagineIdToken(): Promise<string> {
  return acquireRegisteredIdToken(CLIENT_ID, TENANT_ID);
}
