import assert from 'node:assert/strict';
import test from 'node:test';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
process.env['AZURE_STORAGE_ACCOUNT_NAME'] = 'legacycms';
process.env['AZURE_STORAGE_ACCOUNT_KEY'] = Buffer.from('legacy-key').toString('base64');
delete process.env['ATHENA_STORAGE_ACCOUNT_NAME'];
delete process.env['ATHENA_STORAGE_ACCOUNT_KEY'];
const { createAthenaStorage, getAthenaStorage } = await import('../src/services/athenaStorage.js');

test('Athena storage requires its own complete credentials', () => {
  for (const [name, key] of [[undefined, undefined], ['account', undefined], [undefined, 'key'], ['', 'key'], ['account', ' ']]) {
    assert.throws(() => createAthenaStorage(name, key), /ATHENA_STORAGE_ACCOUNT_NAME/);
  }
});

test('Athena storage uses the dedicated account', () => {
  const { service, credential } = createAthenaStorage('athenatest', Buffer.from('test-key').toString('base64'));
  assert.equal(service.url, 'https://athenatest.blob.core.windows.net/');
  assert.equal(credential.accountName, 'athenatest');
});

test('CMS credentials alone cannot enable Athena storage', () => {
  assert.throws(() => getAthenaStorage(), /CMS credentials are not used/);
});
