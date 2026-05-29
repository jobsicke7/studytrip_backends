import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config as loadEnv } from 'dotenv';
import { createReadStream, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env') });

const sourceDir = resolve(process.argv[2] ?? 'background');
const bucket = process.env.R2_BUCKET ?? '';
const accountId = process.env.R2_ACCOUNT_ID ?? '';
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? '';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? '';
const keyPrefix = (process.env.BACKGROUND_KEY_PREFIX ?? 'background').replace(/^\/|\/$/g, '');

if (!bucket || !accountId || !accessKeyId || !secretAccessKey) {
  throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET are required.');
}

const contentTypes = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

const entries = await readdir(sourceDir, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && contentTypes.has(extname(entry.name).toLowerCase()))
  .map((entry) => join(sourceDir, entry.name));

if (files.length === 0) {
  throw new Error(`No background image files found in ${sourceDir}`);
}

for (const filePath of files) {
  const ext = extname(filePath).toLowerCase();
  const fileName = filePath.split(/[\\/]/).pop();
  const key = `${keyPrefix}/${fileName}`;
  const stat = statSync(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: stat.size,
      ContentType: contentTypes.get(ext),
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  console.log(`uploaded ${fileName} -> r2://${bucket}/${key}`);
}
