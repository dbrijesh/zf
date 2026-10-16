import fs from 'node:fs';
import path from 'node:path';

/** Logs, transcripts, screenshots and uploaded context files live here (spec 4). */
export interface ArtifactStore {
  put(key: string, data: Buffer | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

const safeKey = (k: string) => {
  if (k.includes('..') || k.startsWith('/') || /^[A-Za-z]:/.test(k)) throw new Error(`invalid artifact key: ${k}`);
  return k;
};

export class FsArtifactStore implements ArtifactStore {
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }
  private p(key: string) {
    return path.join(this.root, ...safeKey(key).split('/'));
  }
  async put(key: string, data: Buffer | string) {
    const f = this.p(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  }
  async get(key: string) {
    const f = this.p(key);
    return fs.existsSync(f) ? fs.readFileSync(f) : undefined;
  }
  async list(prefix: string) {
    const base = this.p(prefix || '.');
    if (!fs.existsSync(base)) return [];
    const out: string[] = [];
    const walk = (d: string, rel: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out.push(r);
      }
    };
    if (fs.statSync(base).isDirectory()) walk(base, prefix.replace(/\/$/, ''));
    return out.sort();
  }
  async delete(key: string) {
    fs.rmSync(this.p(key), { force: true, recursive: true });
  }
}

/** S3-compatible store (MinIO in compose). The AWS SDK is loaded on first use. */
export class S3ArtifactStore implements ArtifactStore {
  private client?: import('@aws-sdk/client-s3').S3Client;
  constructor(private o: { bucket: string; endpoint?: string; region?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle?: boolean }) {}
  private async c() {
    if (!this.client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      this.client = new S3Client({ region: this.o.region ?? 'us-east-1', endpoint: this.o.endpoint, forcePathStyle: this.o.forcePathStyle ?? !!this.o.endpoint, credentials: this.o.accessKeyId ? { accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey ?? '' } : undefined });
    }
    return this.client;
  }
  async put(key: string, data: Buffer | string, contentType?: string) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.c()).send(new PutObjectCommand({ Bucket: this.o.bucket, Key: safeKey(key), Body: data, ContentType: contentType }));
  }
  async get(key: string) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const r = await (await this.c()).send(new GetObjectCommand({ Bucket: this.o.bucket, Key: safeKey(key) }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return undefined;
      throw e;
    }
  }
  async list(prefix: string) {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await (await this.c()).send(new ListObjectsV2Command({ Bucket: this.o.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.c()).send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: safeKey(key) }));
  }
}

export function artifactStoreFromEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env): ArtifactStore {
  if (env.S3_BUCKET) return new S3ArtifactStore({ bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY });
  return new FsArtifactStore(path.join(dataDir, 'artifacts'));
}
