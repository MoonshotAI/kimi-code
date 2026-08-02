/**
 * v1-compatible wire event history for the SDK host.
 *
 * The retired KimiCore persisted every agent event to
 * `<homeDir>/sessions/<id>/agents/main/wire.jsonl` (indexed by
 * `session_index.jsonl`), and hosts/tests read that history to observe
 * behavior and restore state on resume. The Rust engine keeps its own
 * records for its own resume; the SDK host still maintains a wire-format
 * event history so v1-shaped consumers (tests, diagnostics, replay) work
 * unchanged against the Rust engine.
 */
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface WireEventPayload {
  readonly type: string;
  readonly [key: string]: unknown;
}

export class WireEventWriter {
  private readonly sessionDir: string;

  private constructor(
    private readonly homeDir: string,
    sessionId: string,
  ) {
    // Keep the v1 layout: `<homeDir>/sessions/<sessionId>`.
    this.sessionDir = join(homeDir, 'sessions', sessionId);
  }

  static async create(homeDir: string, sessionId: string): Promise<WireEventWriter> {
    const writer = new WireEventWriter(homeDir, sessionId);
    await writer.ensureIndexed();
    return writer;
  }

  get wireFile(): string {
    return join(this.sessionDir, 'agents', 'main', 'wire.jsonl');
  }

  private async ensureIndexed(): Promise<void> {
    await mkdir(join(this.sessionDir, 'agents', 'main'), { recursive: true });
    const indexFile = join(this.homeDir, 'session_index.jsonl');
    const sessionId = this.sessionDir.split(/[\\/]/).at(-1) ?? '';
    const rows = await this.readIndex(indexFile);
    const filtered = rows.filter((r) => r.sessionId !== sessionId);
    filtered.push({ sessionId, sessionDir: this.sessionDir });
    await writeFile(
      indexFile,
      filtered.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
  }

  private async readIndex(
    indexFile: string,
  ): Promise<Array<{ sessionId: string; sessionDir: string }>> {
    try {
      const raw = await readFile(indexFile, 'utf-8');
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            const parsed = JSON.parse(line) as {
              sessionId?: unknown;
              sessionDir?: unknown;
            };
            return {
              sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
              sessionDir: typeof parsed.sessionDir === 'string' ? parsed.sessionDir : '',
            };
          } catch {
            return { sessionId: '', sessionDir: '' };
          }
        })
        .filter((row) => row.sessionId.length > 0);
    } catch {
      return [];
    }
  }

  /** Append one wire event to this session's history. */
  async append(event: WireEventPayload): Promise<void> {
    await appendFile(this.wireFile, JSON.stringify(event) + '\n', 'utf-8');
  }
}
