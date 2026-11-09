import { existsSync } from 'node:fs';
import { join } from 'pathe';
import type { EnvironmentPath } from '#/environment/environment';

import { BugIndicatingError } from '#/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FileBody } from '#/tool/executor/output-store';
import type { ToolOutput } from '#/tool/executor/types';

const VALID_TASK_ID: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

const TASKS_SCOPE = 'tasks';
const OUTPUT_LOG_KEY = 'output.log';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface AgentTaskPersistenceRoot {
  readonly dir: string;
  readonly scope: string;
}

export interface AgentTaskSpillTarget {
  readonly fs: IHostFileSystem;
  readonly dir: string;
  readonly path?: Pick<EnvironmentPath, 'join'>;
}

export interface AgentTaskStoredOutputSnapshot {
  readonly outputPath: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly preview: string;
}

interface TaskOutputData {
  readonly root: AgentTaskPersistenceRoot;
  readonly data: Uint8Array;
}

function validateTaskId(taskId: string): void {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new BugIndicatingError(`Invalid task id: "${taskId}"`);
  }
}

export function isTaskOutputFilePath(path: string, agentDir: string, pathApi: Pick<EnvironmentPath, 'isAbsolute' | 'relative'>): boolean {
  if (!pathApi.isAbsolute(path) || path.includes('\0')) return false;
  const parts = pathApi.relative(agentDir, path).replaceAll('\\', '/').split('/');
  return parts.length === 3 && parts[0] === TASKS_SCOPE && VALID_TASK_ID.test(parts[1]!) && parts[2] === OUTPUT_LOG_KEY;
}

export class AgentTaskPersistence {
  private readonly mirrors = new WeakMap<IHostFileSystem, Map<string, { readonly scope: string; readonly size: number }>>();
  private readonly bodies = new Map<string, FileBody>();
  private readonly outputs = new Map<string, ToolOutput>();
  private readonly outputTails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly agentDir: string,
    private readonly agentScope: string,
    private readonly bytes: IFileSystemStorageService,
    private readonly fallbackRoot?: AgentTaskPersistenceRoot,
    private readonly spillTarget?: () => AgentTaskSpillTarget | undefined,
  ) {}

  private primaryRoot(): AgentTaskPersistenceRoot {
    return { dir: this.agentDir, scope: this.agentScope };
  }

  private taskOutputScope(
    taskId: string,
    root: AgentTaskPersistenceRoot = this.primaryRoot(),
  ): string {
    validateTaskId(taskId);
    return `${root.scope}/${TASKS_SCOPE}/${taskId}`;
  }

  private taskOutputFileAt(taskId: string, root: AgentTaskPersistenceRoot): string {
    validateTaskId(taskId);
    return join(root.dir, TASKS_SCOPE, taskId, OUTPUT_LOG_KEY);
  }

  private taskOutputPhysicalFile(taskId: string): string {
    return this.bytes.pathFor?.(this.taskOutputScope(taskId), OUTPUT_LOG_KEY) ??
      this.taskOutputFileAt(taskId, this.primaryRoot());
  }

  private async outputPathFor(taskId: string, output: TaskOutputData): Promise<string> {
    const target = this.spillTarget?.();
    if (target !== undefined && await this.mirrorOutput(taskId, output, target)) {
      return (target.path?.join ?? join)(target.dir, `${taskId}.log`);
    }
    return this.taskOutputFileAt(taskId, output.root);
  }

  private async mirrorOutput(taskId: string, output: TaskOutputData, target: AgentTaskSpillTarget): Promise<boolean> {
    const mirrors = this.mirrors.get(target.fs) ?? new Map<string, { readonly scope: string; readonly size: number }>();
    this.mirrors.set(target.fs, mirrors);
    const path = (target.path?.join ?? join)(target.dir, `${taskId}.log`);
    const mirrored = mirrors.get(path);
    if (mirrored?.scope === output.root.scope && mirrored.size === output.data.byteLength) return true;
    try {
      await target.fs.mkdir(target.dir, { recursive: true });
      await target.fs.writeText(path, textDecoder.decode(output.data));
      mirrors.set(path, { scope: output.root.scope, size: output.data.byteLength });
      return true;
    } catch {
      mirrors.delete(path);
      return false;
    }
  }

  private serializeOutput<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    validateTaskId(taskId);
    const run = (this.outputTails.get(taskId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.outputTails.set(taskId, run);
    return run.finally(() => {
      if (this.outputTails.get(taskId) === run) this.outputTails.delete(taskId);
    });
  }

  taskOutputFile(taskId: string): string {
    return this.taskOutputFileAt(taskId, this.primaryRoot());
  }

  open(taskId: string): ToolOutput {
    const current = this.outputs.get(taskId);
    if (current !== undefined && current.closed !== true) return current;
    const body = this.bodies.get(taskId) ?? new FileBody(this.taskOutputPhysicalFile(taskId), 0o700);
    this.bodies.set(taskId, body);
    const output = body.open();
    this.outputs.set(taskId, output);
    return output;
  }

  async appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    if (chunk.length === 0) return;
    await this.serializeOutput(taskId, async () => {
      const previousSize = await this.taskOutputSizeBytes(taskId);
      const output = this.open(taskId);
      if (output.append(chunk) === undefined) {
        throw new Error(output.error() ?? `Unable to append task output: ${taskId}`);
      }
      await output.flush();
      const size = output.preview(0).totalBytes;
      const target = this.spillTarget?.();
      if (target === undefined) return;
      const path = (target.path?.join ?? join)(target.dir, `${taskId}.log`);
      const mirrors = this.mirrors.get(target.fs);
      const mirrored = mirrors?.get(path);
      if (mirrored?.scope === this.agentScope && mirrored.size === previousSize) {
        try {
          await target.fs.appendText(path, chunk);
          mirrors!.set(path, { scope: this.agentScope, size });
        } catch {
          mirrors!.delete(path);
        }
        return;
      }
      const persisted = await this.readTaskOutputData(taskId);
      if (persisted !== undefined) await this.mirrorOutput(taskId, persisted, target);
    });
  }

  async taskOutputSizeBytes(taskId: string): Promise<number> {
    const output = await this.readTaskOutputData(taskId);
    return output?.data.byteLength ?? 0;
  }

  async taskOutputExists(taskId: string): Promise<boolean> {
    return (await this.readTaskOutputData(taskId)) !== undefined;
  }

  async readTaskOutputBytes(taskId: string, offset: number, maxBytes: number): Promise<string> {
    const start = Math.max(0, Math.trunc(offset));
    const limit = Math.max(0, Math.trunc(maxBytes));
    if (limit === 0) return '';
    const output = await this.readTaskOutputData(taskId);
    if (output === undefined || start >= output.data.byteLength) return '';
    const end = Math.min(output.data.byteLength, start + limit);
    return textDecoder.decode(output.data.subarray(start, end));
  }

  async readTaskOutputTail(
    taskId: string,
    maxBytes: number,
  ): Promise<{ readonly offset: number; readonly data: Uint8Array } | undefined> {
    await this.flushTaskOutput(taskId);
    if (existsSync(this.taskOutputPhysicalFile(taskId))) {
      const output = this.open(taskId);
      const totalBytes = output.preview(0).totalBytes;
      const offset = Math.max(0, totalBytes - Math.max(0, Math.trunc(maxBytes)));
      if (offset === totalBytes) return { offset, data: new Uint8Array() };
      return { offset, data: Buffer.from(await output.read(offset, totalBytes - offset)) };
    }
    const root = this.fallbackRoot;
    if (root === undefined) return undefined;
    const scope = this.taskOutputScope(taskId, root);
    const size = await this.bytes.size(scope, OUTPUT_LOG_KEY);
    if (size === undefined) return undefined;
    const offset = Math.max(0, size - Math.max(0, Math.trunc(maxBytes)));
    if (offset === size) return { offset, data: new Uint8Array() };
    const parts: Uint8Array[] = [];
    for await (const part of this.bytes.readStream(scope, OUTPUT_LOG_KEY, { start: offset, end: size - 1 })) {
      parts.push(part);
    }
    return { offset, data: Buffer.concat(parts) };
  }

  async readTaskOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskStoredOutputSnapshot | undefined> {
    return this.serializeOutput(taskId, async () => {
      const output = await this.readTaskOutputData(taskId);
      if (output === undefined) return undefined;
      const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
      const previewBytes = Math.min(previewLimit, output.data.byteLength);
      const previewOffset = output.data.byteLength - previewBytes;
      return {
        outputPath: await this.outputPathFor(taskId, output),
        outputSizeBytes: output.data.byteLength,
        previewBytes,
        truncated: previewOffset > 0,
        preview: textDecoder.decode(output.data.subarray(previewOffset)),
      };
    });
  }

  private async flushTaskOutput(taskId: string): Promise<void> {
    const output = this.outputs.get(taskId);
    if (output !== undefined && output.error() !== 'Tool output is closed') await output.flush();
  }

  private async readTaskOutputData(taskId: string): Promise<TaskOutputData | undefined> {
    await this.flushTaskOutput(taskId);
    const primaryRoot = this.primaryRoot();
    if (existsSync(this.taskOutputPhysicalFile(taskId))) {
      const output = this.open(taskId);
      const totalBytes = output.preview(0).totalBytes;
      return { root: primaryRoot, data: textEncoder.encode(await output.read(0, totalBytes)) };
    }
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot === undefined) return undefined;
    const fallback = await this.bytes.read(
      this.taskOutputScope(taskId, fallbackRoot),
      OUTPUT_LOG_KEY,
    );
    return fallback === undefined ? undefined : { root: fallbackRoot, data: fallback };
  }
}
