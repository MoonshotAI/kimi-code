import {
  type SessionRecord,
  type SessionSpace,
  type SessionSpaceBackend,
} from '../model';
import { createSessionSpace } from '../space';

class MemorySessionSpaceBackend<T extends SessionRecord> implements SessionSpaceBackend<T> {
  private readonly records = new Map<string, string>();

  async list(prefix?: string): Promise<readonly string[]> {
    return [...this.records.keys()]
      .filter((key) => prefix === undefined || key.startsWith(prefix))
      .toSorted();
  }

  async read(key: string): Promise<T | undefined> {
    const record = this.records.get(key);
    return record === undefined ? undefined : JSON.parse(record) as T;
  }

  async write(key: string, record: T): Promise<void> {
    this.records.set(key, JSON.stringify(record));
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
}

export function memorySessionSpace<T extends SessionRecord = SessionRecord>(
  now?: () => number,
): SessionSpace<T> {
  return createSessionSpace(new MemorySessionSpaceBackend<T>(), now);
}
