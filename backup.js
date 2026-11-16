import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sql from './db.js';
import { APP_ID } from './site.js';

function encryptionKey(value) {
  const key = Buffer.from(value || '', 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return key;
}

export function encryptBackup(records, keyValue) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(records), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptBackup(encrypted, keyValue) {
  if (encrypted?.version !== 1 || encrypted?.algorithm !== 'aes-256-gcm') throw new Error('Unsupported backup format.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyValue), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

function configured(env) {
  return ['BACKUP_BUCKET', 'BACKUP_REGION', 'BACKUP_ACCESS_KEY_ID', 'BACKUP_SECRET_ACCESS_KEY', 'BACKUP_ENCRYPTION_KEY']
    .every(name => typeof env[name] === 'string' && env[name].length > 0);
}

export async function backupRecords({ sqlClient = sql, s3Client, env = process.env, now = new Date() } = {}) {
  if (!configured(env)) return { status: 'not_configured' };
  const records = {
    firms: await sqlClient`SELECT * FROM firms ORDER BY id`,
    leads: await sqlClient`SELECT * FROM leads ORDER BY id`,
    auctions: await sqlClient`SELECT * FROM auctions ORDER BY id`,
    bids: await sqlClient`SELECT * FROM bids ORDER BY id`,
  };
  const encrypted = encryptBackup({
    version: 1,
    application: APP_ID,
    createdAt: now.toISOString(),
    records,
  }, env.BACKUP_ENCRYPTION_KEY);
  const prefix = (env.BACKUP_PREFIX || APP_ID).replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.split('/').includes('..')) throw new Error('BACKUP_PREFIX must be a safe object-key prefix.');
  const date = now.toISOString();
  const key = `${prefix}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}/${date.replace(/[:.]/g, '-')}.json`;
  const client = s3Client || new S3Client({
    region: env.BACKUP_REGION,
    credentials: {
      accessKeyId: env.BACKUP_ACCESS_KEY_ID,
      secretAccessKey: env.BACKUP_SECRET_ACCESS_KEY,
    },
    ...(env.BACKUP_ENDPOINT ? { endpoint: env.BACKUP_ENDPOINT, forcePathStyle: true } : {}),
  });
  const body = JSON.stringify(encrypted);
  await client.send(new PutObjectCommand({
    Bucket: env.BACKUP_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/json',
    ServerSideEncryption: 'AES256',
    Metadata: { application: APP_ID },
  }));
  return {
    status: 'ok',
    key,
    bytes: Buffer.byteLength(body),
    counts: Object.fromEntries(Object.entries(records).map(([table, rows]) => [table, rows.length])),
  };
}
