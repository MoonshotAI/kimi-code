import {
  createKimiHarness,
  type KimiHarness,
  type Session,
  type SessionSummary,
  type ThinkingEffort,
} from "@moonshot-ai/kimi-code-sdk";

import type { RuntimeBroadcast } from "./session-runtime";
import {
  corePermissionForLegacyApproval,
  legacyApprovalMetadata,
  readLegacyApprovalFlags,
  readMigratedLegacyApprovalFlags,
  withGlobalYoloMode,
  type LegacyApprovalFlags,
} from "./legacy-approval";
import { SessionRuntime } from "./session-runtime";
import { areSameFsPath } from "../utils/fs-path";

export interface KimiRuntimeOptions {
  readonly version: string;
  readonly broadcast: RuntimeBroadcast;
  readonly captureBaseline: (
    session: Pick<SessionSummary, "id" | "workDir" | "metadata">,
    filePath: string,
    webviewIds: readonly string[],
  ) => void;
  readonly log: (message: string, error?: unknown) => void;
  readonly homeDir?: string;
  readonly harness?: KimiHarness;
}

export interface OpenSessionOptions {
  readonly webviewId: string;
  readonly workDir: string;
  readonly sessionId?: string;
  readonly model: string;
  readonly effort: string;
  readonly yoloMode: boolean;
}

/** Extension-host owner for one in-process Node SDK harness. */
export class KimiRuntime {
  readonly harness: KimiHarness;

  private readonly broadcast: RuntimeBroadcast;
  private readonly captureBaseline: KimiRuntimeOptions["captureBaseline"];
  private readonly log: KimiRuntimeOptions["log"];
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly sessionByView = new Map<string, string>();
  private closed = false;

  constructor(options: KimiRuntimeOptions) {
    this.broadcast = options.broadcast;
    this.captureBaseline = options.captureBaseline;
    this.log = options.log;
    this.harness =
      options.harness ??
      createKimiHarness({
        ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
        identity: {
          userAgentProduct: "kimi-code-vscode",
          version: options.version,
        },
        uiMode: "vscode",
      });
  }

  getSessionForView(webviewId: string): SessionRuntime | undefined {
    const id = this.sessionByView.get(webviewId);
    return id === undefined ? undefined : this.sessions.get(id);
  }

  getSession(id: string): SessionRuntime | undefined {
    return this.sessions.get(id);
  }

  async openSession(options: OpenSessionOptions): Promise<SessionRuntime> {
    this.ensureOpen();
    const current = this.getSessionForView(options.webviewId);
    const requestedId = options.sessionId ?? current?.id;

    if (
      current !== undefined &&
      requestedId === current.id &&
      areSameFsPath(current.session.workDir, options.workDir)
    ) {
      await applySessionSettings(current.session, options, current.legacyApprovalFlags);
      await current.announceStatus(options.webviewId);
      return current;
    }

    let runtime = requestedId === undefined ? undefined : this.sessions.get(requestedId);
    if (runtime !== undefined) {
      assertSessionWorkDir(runtime.session, options.workDir);
      await applySessionSettings(runtime.session, options, runtime.legacyApprovalFlags);
      await this.detachView(options.webviewId);
    } else {
      const defaultApproval: LegacyApprovalFlags = { yolo: options.yoloMode, afk: false };
      const session =
        requestedId === undefined
          ? await this.harness.createSession({
              workDir: options.workDir,
              model: options.model || undefined,
              thinking: normalizeEffort(options.effort),
              permission: corePermissionForLegacyApproval(defaultApproval),
              metadata: legacyApprovalMetadata(defaultApproval),
            })
          : await this.harness.resumeSession({ id: requestedId, includeSubagents: true });
      try {
        assertSessionWorkDir(session, options.workDir);
        const storedApproval = readLegacyApprovalFlags(session.summary?.metadata);
        const restoredApproval =
          storedApproval ?? (await this.readMigratedLegacyApproval(session)) ?? defaultApproval;
        const approval = withGlobalYoloMode(restoredApproval, options.yoloMode);
        if (storedApproval === undefined || flagsDiffer(storedApproval, approval)) {
          await session.updateMetadata(legacyApprovalMetadata(approval));
        }
        await applySessionSettings(session, options, approval);
        await this.detachView(options.webviewId);
        runtime = this.wrapSession(session, approval);
      } catch (error) {
        await session.close().catch((closeError: unknown) => {
          this.log("Failed to close a rejected session", closeError);
        });
        throw error;
      }
    }

    runtime.subscribe(options.webviewId);
    this.sessionByView.set(options.webviewId, runtime.id);
    await runtime.announceStatus(options.webviewId);
    return runtime;
  }

  async attachResumedSession(
    webviewId: string,
    session: Session,
    defaultYoloMode = false,
  ): Promise<SessionRuntime> {
    const existing = this.sessions.get(session.id);
    if (existing !== undefined && this.sessionByView.get(webviewId) === session.id) {
      existing.subscribe(webviewId);
      await existing.announceStatus(webviewId);
      return existing;
    }
    await this.detachView(webviewId);
    let runtime = existing ?? this.sessions.get(session.id);
    if (runtime === undefined) {
      try {
        const storedApproval = readLegacyApprovalFlags(session.summary?.metadata);
        const restoredApproval =
          storedApproval ??
          (await this.readMigratedLegacyApproval(session)) ??
          { yolo: defaultYoloMode, afk: false };
        const approval = withGlobalYoloMode(restoredApproval, defaultYoloMode);
        if (storedApproval === undefined || flagsDiffer(storedApproval, approval)) {
          await session.updateMetadata(legacyApprovalMetadata(approval));
        }
        const status = await session.getStatus();
        const permission = corePermissionForLegacyApproval(approval);
        if (status.permission !== permission) await session.setPermission(permission);
        runtime = this.wrapSession(session, approval);
      } catch (error) {
        await session.close().catch((closeError: unknown) => {
          this.log("Failed to close a rejected session", closeError);
        });
        throw error;
      }
    }
    runtime.subscribe(webviewId);
    this.sessionByView.set(webviewId, runtime.id);
    await runtime.announceStatus(webviewId);
    return runtime;
  }

  async detachView(webviewId: string): Promise<void> {
    const id = this.sessionByView.get(webviewId);
    if (id === undefined) return;
    this.sessionByView.delete(webviewId);
    const runtime = this.sessions.get(id);
    if (runtime === undefined) return;
    runtime.unsubscribeView(webviewId);
    if (runtime.subscribers.length === 0) {
      this.sessions.delete(id);
      await runtime.close();
    }
  }

  async closeSession(id: string): Promise<void> {
    const runtime = this.sessions.get(id);
    if (runtime === undefined) {
      await this.harness.closeSession(id);
      return;
    }
    this.sessions.delete(id);
    for (const webviewId of runtime.subscribers) {
      this.sessionByView.delete(webviewId);
    }
    await runtime.close();
  }

  async deleteSession(id: string): Promise<void> {
    await this.closeSession(id);
    await this.harness.deleteSession(id);
  }

  async setYoloModeForActiveSessions(enabled: boolean): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) => session.setLegacyYoloMode(enabled)),
    );
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    this.sessionByView.clear();
    await this.harness.close();
  }

  private wrapSession(session: Session, legacyApproval: LegacyApprovalFlags): SessionRuntime {
    const runtime = new SessionRuntime({
      session,
      legacyApproval,
      broadcast: this.broadcast,
      captureBaseline: this.captureBaseline,
      log: this.log,
    });
    this.sessions.set(session.id, runtime);
    return runtime;
  }

  private async readMigratedLegacyApproval(
    session: Session,
  ): Promise<LegacyApprovalFlags | undefined> {
    const metadata = session.summary?.metadata;
    try {
      return await readMigratedLegacyApprovalFlags(metadata);
    } catch (error) {
      this.log("Unable to restore legacy session approval settings", error);
      return undefined;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Kimi runtime is closed.");
  }
}

async function applySessionSettings(
  session: Session,
  options: OpenSessionOptions,
  legacyApproval: LegacyApprovalFlags,
): Promise<void> {
  const status = await session.getStatus();
  if (options.model && status.model !== options.model) {
    await session.setModel(options.model);
  }
  // Thinking effort is applied only when the session is created (see
  // openSession). An existing session keeps its own effort — the global
  // config value is a default for new sessions, matching CLI/TUI resume
  // semantics. Effort changes made in the picker reach the active session
  // through the SaveConfig handler instead.
  const permission = corePermissionForLegacyApproval(legacyApproval);
  if (status.permission !== permission) {
    await session.setPermission(permission);
  }
}

function normalizeEffort(effort: string): ThinkingEffort {
  return (effort.trim() || "off") as ThinkingEffort;
}

function flagsDiffer(a: LegacyApprovalFlags, b: LegacyApprovalFlags): boolean {
  return a.yolo !== b.yolo || a.afk !== b.afk;
}

function assertSessionWorkDir(session: Pick<Session, "workDir">, expectedWorkDir: string): void {
  if (!areSameFsPath(session.workDir, expectedWorkDir)) {
    throw new Error("The selected session belongs to a different working directory.");
  }
}
