import {
  createKimiHarness,
  type KimiHarness,
  type Session,
  type SessionSummary,
  type ThinkingEffort,
} from "@moonshot-ai/kimi-code-sdk";
import { setTelemetryContext, track, withTelemetryContext } from "@moonshot-ai/kimi-telemetry";

import { Events } from "../../shared/bridge";
import { BUSINESS_MEMBERSHIP_REVOKED_MESSAGE } from "../../shared/errors";
import { startModelCatalogRefresh } from "./model-catalog-refresh";
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
  readonly onAuthChanged?: () => Promise<void> | void;
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

export class KimiRuntime {
  readonly harness: KimiHarness;

  private readonly broadcast: RuntimeBroadcast;
  private readonly captureBaseline: KimiRuntimeOptions["captureBaseline"];
  private readonly log: KimiRuntimeOptions["log"];
  private readonly onAuthChanged: KimiRuntimeOptions["onAuthChanged"];
  private readonly disposeModelCatalogRefresh: () => void;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly sessionByView = new Map<string, string>();
  private readonly viewChains = new Map<string, Promise<void>>();
  private readonly deferredModelSyncSessions = new Set<string>();
  private authMutationChain: Promise<void> = Promise.resolve();
  private revokingFlight: Promise<void> | undefined;
  private _authGeneration = 0;
  private closed = false;

  constructor(options: KimiRuntimeOptions) {
    this.broadcast = options.broadcast;
    this.captureBaseline = options.captureBaseline;
    this.log = options.log;
    this.onAuthChanged = options.onAuthChanged;
    this.harness =
      options.harness ??
      createKimiHarness({
        homeDir: options.homeDir,
        identity: {
          productName: "kimi-code-vscode",
          version: options.version,
          platform: "kimi_code_vscode",
        },
        uiMode: "vscode",
        telemetry: {
          track,
          withContext: withTelemetryContext,
          setContext: setTelemetryContext,
        },
      });
    this.disposeModelCatalogRefresh = startModelCatalogRefresh({
      harness: this.harness,
      onChanged: () => {
        this.broadcast(Events.ModelCatalogChanged, {});
      },
      log: this.log,
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
    return this.serializeView(options.webviewId, () => this.openSessionInner(options));
  }

  private async openSessionInner(options: OpenSessionOptions): Promise<SessionRuntime> {
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
      await this.detachViewInner(options.webviewId);
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
        await this.detachViewInner(options.webviewId);
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
    return this.serializeView(webviewId, () =>
      this.attachResumedSessionInner(webviewId, session, defaultYoloMode),
    );
  }

  private async attachResumedSessionInner(
    webviewId: string,
    session: Session,
    defaultYoloMode: boolean,
  ): Promise<SessionRuntime> {
    const existing = this.sessions.get(session.id);
    if (existing !== undefined && this.sessionByView.get(webviewId) === session.id) {
      existing.subscribe(webviewId);
      await existing.announceStatus(webviewId);
      return existing;
    }
    await this.detachViewInner(webviewId);
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
    return this.serializeView(webviewId, () => this.detachViewInner(webviewId));
  }

  private async detachViewInner(webviewId: string): Promise<void> {
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

  private serializeView<T>(webviewId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.viewChains.get(webviewId) ?? Promise.resolve();
    const run = prev.then(work, work);
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    this.viewChains.set(webviewId, next);
    void next.finally(() => {
      if (this.viewChains.get(webviewId) === next) this.viewChains.delete(webviewId);
    });
    return run;
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

  get authGeneration(): number {
    return this._authGeneration;
  }

  bumpAuthGeneration(): number {
    this._authGeneration += 1;
    return this._authGeneration;
  }

  waitForAuthMutations(): Promise<void> {
    return this.authMutationChain;
  }

  async hasBusyManagedSession(): Promise<boolean> {
    const busySessions = [...this.sessions.values()].filter((runtime) => runtime.isBusy);
    if (busySessions.length === 0) return false;
    try {
      const config = await this.harness.getConfig();
      for (const runtime of busySessions) {
        const status = await runtime.session.getStatus();
        const modelId = status.model || config.defaultModel;
        const entry = modelId ? config.models?.[modelId] : undefined;
        if (entry?.provider === "managed:kimi-code") {
          return true;
        }
      }
    } catch (error) {
      this.log("Unable to inspect busy session model before workspace switch", error);
      return true;
    }
    return false;
  }

  enqueueAuthMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.authMutationChain.then(work, work);
    this.authMutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async syncActiveSessionsModel(): Promise<void> {
    if (this.closed) return;
    try {
      const config = await this.harness.getConfig({ reload: true });
      if (this.sessions.size === 0) return;
      await Promise.all(
        [...this.sessions.values()].map((runtime) => this.syncSingleSessionModel(runtime, config)),
      );
    } catch (error) {
      this.log("Unable to reload config after workspace switch", error);
    }
  }

  private deferBusySessionModelSync(runtime: SessionRuntime): void {
    if (this.deferredModelSyncSessions.has(runtime.id)) return;
    this.deferredModelSyncSessions.add(runtime.id);
    void runtime.whenIdle().then(async () => {
      this.deferredModelSyncSessions.delete(runtime.id);
      if (this.closed || !this.sessions.has(runtime.id)) return;
      try {
        const config = await this.harness.getConfig({ reload: true });
        await this.syncSingleSessionModel(runtime, config);
      } catch (error) {
        this.log("Unable to reload config after deferred session turn settled", error);
      }
    });
  }

  private async syncSingleSessionModel(
    runtime: SessionRuntime,
    config: Awaited<ReturnType<KimiHarness["getConfig"]>>,
  ): Promise<void> {
    if (runtime.isBusy) {
      this.deferBusySessionModelSync(runtime);
      return;
    }
    const models = config.models ?? {};
    const fallback =
      config.defaultModel !== undefined && config.defaultModel in models
        ? config.defaultModel
        : Object.keys(models)[0];
    if (!fallback) return;
    try {
      const status = await runtime.session.getStatus();
      if (status.model && !(status.model in models)) {
        await runtime.session.setModel(fallback);
        const targetEffort =
          config.thinking?.enabled === false
            ? "off"
            : normalizeEffort(config.thinking?.effort ?? "on");
        await runtime.session.setThinking(targetEffort).catch(async () => {
          await runtime.session.setThinking("off").catch(() => undefined);
        });
        await Promise.all(
          runtime.subscribers.map((webviewId) => runtime.announceStatus(webviewId)),
        );
      }
    } catch (error) {
      this.log("Unable to sync session model after workspace switch", error);
    }
  }

  async performBusinessMembershipRevocation(): Promise<void> {
    let shouldRevoke = false;
    try {
      const [status, config] = await Promise.all([
        this.harness.auth?.status?.(),
        this.harness.getConfig().catch(() => undefined),
      ]);
      const hasManagedToken =
        status?.providers.some(
          (provider) => provider.providerName === "managed:kimi-code" && provider.hasToken,
        ) ?? false;
      const hasManagedProviderConfig = Boolean(config?.providers?.["managed:kimi-code"]);
      shouldRevoke = hasManagedToken || hasManagedProviderConfig;
      if (!shouldRevoke) {
        return;
      }
      this._authGeneration += 1;
      await this.harness.auth?.logout?.();
    } catch (error) {
      this.log("Failed to clear credentials after business membership revocation", error);
    }
    try {
      await this.onAuthChanged?.();
    } catch (error) {
      this.log("Failed to refresh login state after business membership revocation", error);
    }
    await this.syncActiveSessionsModel();
    this.broadcast(Events.ModelCatalogChanged, {});
    this.broadcast(Events.BusinessMembershipRevoked, {
      message: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
    });
  }

  handleBusinessMembershipRevoked(): Promise<void> {
    if (this.revokingFlight !== undefined) return this.revokingFlight;
    const flight = this.enqueueAuthMutation(() => this.performBusinessMembershipRevocation()).finally(
      () => {
        if (this.revokingFlight === flight) this.revokingFlight = undefined;
      },
    );
    this.revokingFlight = flight;
    return flight;
  }

  async handleModelBusinessMembershipRevoked(modelId?: string): Promise<void> {
    try {
      const config = await this.harness.getConfig();
      const resolvedId = modelId || config.defaultModel;
      const modelEntry = resolvedId ? config.models?.[resolvedId] : undefined;
      if (modelEntry?.provider !== "managed:kimi-code") {
        return;
      }
    } catch (error) {
      this.log("Unable to inspect model provider during membership revocation check", error);
      return;
    }
    await this.handleBusinessMembershipRevoked();
  }

  async handleSessionBusinessMembershipRevoked(session: Session): Promise<void> {
    try {
      const status = await session.getStatus();
      await this.handleModelBusinessMembershipRevoked(status.model);
    } catch (error) {
      this.log("Unable to inspect session model during membership revocation check", error);
    }
  }

  async dispose(): Promise<void> {
    this.disposeModelCatalogRefresh();
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
      onBusinessMembershipRevoked: (targetSession) => {
        void this.handleSessionBusinessMembershipRevoked(targetSession);
      },
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
  const permission = corePermissionForLegacyApproval(legacyApproval);
  if (status.permission !== permission) {
    await session.setPermission(permission);
  }
}

export function normalizeEffort(effort: string): ThinkingEffort {
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
