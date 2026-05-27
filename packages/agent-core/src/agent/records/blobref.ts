import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'pathe';
import type { ContentPart, Message } from '@moonshot-ai/kosong';
import type { AgentRecord } from './types';

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;
const BLOBREF_PROTOCOL = 'blobref:';
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;
const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export function isBlobRef(url: string): boolean {
  return url.startsWith(BLOBREF_PROTOCOL);
}

export interface BlobStoreOptions {
  readonly blobsDir: string;
  readonly threshold?: number;
  readonly maxCacheSize?: number;
}

export class BlobStore {
  private readonly blobsDir: string;
  private readonly threshold: number;
  private readonly maxCacheSize: number;
  private readonly cache = new Map<string, string>();
  private readonly cacheSizes = new Map<string, number>();
  private currentCacheSize = 0;

  constructor(options: BlobStoreOptions) {
    this.blobsDir = options.blobsDir;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
  }

  async offload(record: AgentRecord): Promise<void> {
    switch (record.type) {
      case 'turn.prompt':
      case 'turn.steer':
        for (const part of record.input) {
          await this.offloadContentPart(part);
        }
        break;
      case 'context.append_message':
        for (const part of record.message.content) {
          await this.offloadContentPart(part);
        }
        break;
      case 'context.append_loop_event': {
        const event = record.event;
        if (event.type === 'tool.result' && typeof event.result.output !== 'string') {
          for (const part of event.result.output) {
            await this.offloadContentPart(part);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  async rehydrate(record: AgentRecord): Promise<void> {
    switch (record.type) {
      case 'turn.prompt':
      case 'turn.steer':
        for (const part of record.input) {
          await this.rehydrateContentPart(part);
        }
        break;
      case 'context.append_message':
        for (const part of record.message.content) {
          await this.rehydrateContentPart(part);
        }
        break;
      case 'context.append_loop_event': {
        const event = record.event;
        if (event.type === 'tool.result' && typeof event.result.output !== 'string') {
          for (const part of event.result.output) {
            await this.rehydrateContentPart(part);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  async rehydrateMessages(messages: readonly Message[]): Promise<Message[]> {
    return Promise.all(
      messages.map(async (msg): Promise<Message> => {
        if (msg.content.length === 0) return msg;
        const clone = structuredClone(msg) as Message;
        for (const part of clone.content) {
          await this.rehydrateContentPart(part);
        }
        return {
          role: clone.role,
          name: clone.name,
          content: clone.content.map((part) => downgradeMissingMedia(part)),
          toolCalls: clone.toolCalls,
          toolCallId: clone.toolCallId,
          partial: clone.partial,
        };
      }),
    );
  }

  private async offloadContentPart(part: ContentPart): Promise<void> {
    const record = part as unknown as Record<string, unknown>;
    for (const value of Object.values(record)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string') continue;

      const newUrl = await this.maybeOffloadString(url);
      if (newUrl !== url) {
        mediaObj.url = newUrl;
      }
    }
  }

  private async rehydrateContentPart(part: ContentPart): Promise<void> {
    const record = part as unknown as Record<string, unknown>;
    for (const value of Object.values(record)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string' || !isBlobRef(url)) continue;

      const newUrl = await this.rehydrateBlobRefUrl(url);
      mediaObj.url = newUrl ?? MISSING_MEDIA_PLACEHOLDER;
    }
  }

  private async rehydrateBlobRefUrl(url: string): Promise<string | undefined> {
    const rest = url.slice(BLOBREF_PROTOCOL.length);
    const semiIdx = rest.indexOf(';');
    if (semiIdx === -1) {
      return undefined;
    }
    const mimeType = rest.slice(0, semiIdx);
    const hash = rest.slice(semiIdx + 1);
    if (hash.length === 0) {
      return undefined;
    }
    const payload = await this.readBlob(hash);
    if (payload === undefined) {
      return undefined;
    }
    return `data:${mimeType};base64,${payload}`;
  }

  private async readBlob(hash: string): Promise<string | undefined> {
    const cached = this.cache.get(hash);
    if (cached !== undefined) {
      // Move the entry to the end so it lives longer than less-recently-used items.
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }
    const payload = await readFile(join(this.blobsDir, hash), 'utf8').catch(() => undefined);
    if (payload !== undefined) {
      this.setCache(hash, payload);
    }
    return payload;
  }

  private async maybeOffloadString(value: string): Promise<string> {
    if (value.startsWith(BLOBREF_PROTOCOL)) {
      return value;
    }
    const match = DATA_URI_HEADER_RE.exec(value);
    if (match === null) {
      return value;
    }
    const mimeType = match[1]!;
    const payload = value.slice(match[0].length);
    if (payload.length < this.threshold) {
      return value;
    }
    return this.writeBlob(mimeType, payload);
  }

  private async writeBlob(mimeType: string, base64Payload: string): Promise<string> {
    await mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    const hash = createHash('sha256').update(base64Payload, 'utf8').digest('hex');
    const blobPath = join(this.blobsDir, hash);
    try {
      const fh = await open(blobPath, 'wx');
      try {
        await fh.writeFile(base64Payload, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EEXIST means the identical payload was already written; deduplication.
      if (code !== 'EEXIST') throw error;
    }
    this.setCache(hash, base64Payload);
    return `${BLOBREF_PROTOCOL}${mimeType};${hash}`;
  }

  private setCache(hash: string, payload: string): void {
    const size = Buffer.byteLength(payload, 'utf8');
    const alreadyCached = this.cache.has(hash);
    if (alreadyCached) {
      const oldSize = this.cacheSizes.get(hash) ?? 0;
      this.currentCacheSize += size - oldSize;
      // Re-insert to update LRU position.
      this.cache.delete(hash);
    } else {
      while (this.currentCacheSize + size > this.maxCacheSize && this.cache.size > 0) {
        this.evictLRU();
      }
      this.currentCacheSize += size;
    }
    this.cache.set(hash, payload);
    this.cacheSizes.set(hash, size);
  }

  private evictLRU(): void {
    const lru = this.cache.keys().next().value;
    if (lru === undefined) return;
    const size = this.cacheSizes.get(lru) ?? 0;
    this.currentCacheSize -= size;
    this.cache.delete(lru);
    this.cacheSizes.delete(lru);
  }
}

function downgradeMissingMedia(part: ContentPart): ContentPart {
  const record = part as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    const mediaObj = asMediaContainer(value);
    if (mediaObj === undefined) continue;
    if (mediaObj.url === MISSING_MEDIA_PLACEHOLDER) {
      return { type: 'text', text: MISSING_MEDIA_PLACEHOLDER };
    }
  }
  return part;
}

function asMediaContainer(value: unknown): { url: unknown } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  return 'url' in obj ? (obj as { url: unknown }) : undefined;
}
