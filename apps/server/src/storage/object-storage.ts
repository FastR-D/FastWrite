import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ObjectStore { put(key: string, body: Uint8Array, contentType: string): Promise<{ key: string; etag: string; bytes: number }>; get(key: string): Promise<{ body: Uint8Array; contentType?: string }>; remove(key: string): Promise<void>; }

export interface S3ClientLike {
  send(command: { input: Record<string, unknown> }): Promise<{ ETag?: string; Body?: AsyncIterable<Uint8Array> | Uint8Array; ContentType?: string }>;
}

export async function createS3ObjectStore(configuration: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix?: string; maxBytes?: number }): Promise<S3ObjectStore> {
  let sdk: any;
  try { sdk = await import("@aws-sdk/client-s3"); } catch { throw new Error("Install @aws-sdk/client-s3 to enable S3/MinIO object storage"); }
  const client = new sdk.S3Client({ endpoint: configuration.endpoint, region: configuration.region, forcePathStyle: true, credentials: { accessKeyId: configuration.accessKey, secretAccessKey: configuration.secretKey } });
  return new S3ObjectStore({ send: (command) => client.send(command) }, configuration.bucket, configuration.prefix, configuration.maxBytes);
}

export class S3ObjectStore implements ObjectStore {
  constructor(private readonly client: S3ClientLike, private readonly bucket: string, private readonly prefix = "", private readonly maxBytes = 256 * 1024 * 1024) {
    if (!bucket.trim()) throw new Error("S3 bucket is required");
  }
  async put(key: string, body: Uint8Array, contentType: string) {
    const normalized = objectKey(key, this.prefix);
    if (body.byteLength > this.maxBytes) throw new Error("Object exceeds configured size limit");
    const result = await this.client.send({ input: { Bucket: this.bucket, Key: normalized, Body: body, ContentType: contentType, ContentLength: body.byteLength, ChecksumSHA256: createHash("sha256").update(body).digest("base64") } });
    return { key, etag: (result.ETag ?? createHash("sha256").update(body).digest("hex")).replaceAll('"', ""), bytes: body.byteLength };
  }
  async get(key: string) {
    const result = await this.client.send({ input: { Bucket: this.bucket, Key: objectKey(key, this.prefix) } });
    const body = result.Body instanceof Uint8Array ? result.Body : await collectBody(result.Body);
    if (body.byteLength > this.maxBytes) throw new Error("Object exceeds configured size limit");
    return { body, ...(result.ContentType ? { contentType: result.ContentType } : {}) };
  }
  async remove(key: string) { await this.client.send({ input: { Bucket: this.bucket, Key: objectKey(key, this.prefix) } }); }
}

export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}
  async put(key: string, body: Uint8Array, contentType: string) { const path = this.path(key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); await writeFile(`${path}.meta.json`, JSON.stringify({ contentType }), "utf8"); return { key, etag: createHash("sha256").update(body).digest("hex"), bytes: body.byteLength }; }
  async get(key: string) { const path = this.path(key); const body = new Uint8Array(await readFile(path)); let contentType: string | undefined; try { contentType = (JSON.parse(await readFile(`${path}.meta.json`, "utf8")) as { contentType?: string }).contentType; } catch {} return { body, ...(contentType ? { contentType } : {}) }; }
  async remove(key: string) { const { unlink } = await import("node:fs/promises"); await unlink(this.path(key)); await unlink(`${this.path(key)}.meta.json`).catch(() => undefined); }
  private path(key: string) { if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes("..")) throw new Error("Invalid object key"); return join(this.root, key); }
}

function objectKey(key: string, prefix: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid object key");
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return normalizedPrefix ? `${normalizedPrefix}/${key}` : key;
}

async function collectBody(body: AsyncIterable<Uint8Array> | Uint8Array | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of body) { chunks.push(chunk); size += chunk.byteLength; }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
