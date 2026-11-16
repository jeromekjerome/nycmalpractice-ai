import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { backupRecords, decryptBackup, encryptBackup } from '../backup.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CONFIG = {
  BACKUP_BUCKET: 'offsite-backups',
  BACKUP_REGION: 'us-east-1',
  BACKUP_ACCESS_KEY_ID: 'test-access',
  BACKUP_SECRET_ACCESS_KEY: 'test-secret',
  BACKUP_ENCRYPTION_KEY: KEY,
};

test('offsite backups are encrypted, authenticated and restorable', () => {
  const source = { records: { firms: [{ id: 7, email: 'private@example.test' }] } };
  const encrypted = encryptBackup(source, KEY);
  assert.ok(!JSON.stringify(encrypted).includes('private@example.test'));
  assert.deepEqual(decryptBackup(encrypted, KEY), source);
  encrypted.ciphertext = Buffer.from('changed').toString('base64');
  assert.throws(() => decryptBackup(encrypted, KEY));
});

test('the nightly backup exports only business records and uploads ciphertext outside the database', async () => {
  const queries = [];
  const sql = async (strings, ...params) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    queries.push(query);
    if (query === 'SELECT * FROM firms ORDER BY id') return [{ id: 7, email: 'private@example.test' }];
    if (query === 'SELECT * FROM leads ORDER BY id') return [{ id: 9, firm_id: 7 }];
    return [];
  };
  const uploads = [];
  const s3Client = { send: async command => { uploads.push(command.input); return { ETag: 'test-etag' }; } };
  const result = await backupRecords({
    sqlClient: sql, s3Client, env: CONFIG, now: new Date('2026-11-15T04:05:06.000Z'),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.counts, { firms: 1, leads: 1, auctions: 0, bids: 0 });
  assert.deepEqual(queries, [
    'SELECT * FROM firms ORDER BY id', 'SELECT * FROM leads ORDER BY id',
    'SELECT * FROM auctions ORDER BY id', 'SELECT * FROM bids ORDER BY id',
  ]);
  assert.ok(queries.every(query => !/tokens|phone_codes/.test(query)));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].Bucket, 'offsite-backups');
  assert.match(uploads[0].Key, /^nycmalpractice\/2026\/11\/15\/.+\.json$/);
  assert.equal(uploads[0].ServerSideEncryption, 'AES256');
  const encrypted = JSON.parse(Buffer.from(uploads[0].Body).toString('utf8'));
  assert.equal(encrypted.algorithm, 'aes-256-gcm');
  assert.ok(!uploads[0].Body.toString().includes('private@example.test'));
  assert.deepEqual(decryptBackup(encrypted, KEY).records.firms[0].email, 'private@example.test');
});

test('an unconfigured offsite destination skips backup without reading records', async () => {
  let reads = 0;
  const result = await backupRecords({ sqlClient: async () => { reads += 1; return []; }, env: {} });
  assert.deepEqual(result, { status: 'not_configured' });
  assert.equal(reads, 0);
});
