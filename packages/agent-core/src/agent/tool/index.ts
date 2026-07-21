import { uniq } from '@antfu/utils';
import type { ChatProvider, Tool } from '@moonshot-ai/kosong';
import picomatch from 'picomatch';

import type { Agent } from '..';
import {
  collectLoadedDynamicToolNames,
} from '../context/dynamic-tools';
import { makeErrorPayload } from '../../errors';
import type { ExecutableTool, ToolUpdate } from '../../loop';
import { createMcpAuthTool } from '../../mcp/auth-tool';
import type { McpConnectionManager, McpServerEntry } from '../../mcp';
import { mcpResultToExecutableOutput } from '../../mcp/output';
import { isMcpToolName, qualifyMcpToolName } from '../../mcp/tool-naming';
import type { MCPClient, MCPToolDefinition } from '../../mcp/types';
import { DEFAULT_AGENT_PROFILES } from '../../profile';
import { resolveSubagentTimeoutMs } from '../../session/subagent-host';
import { extendWorkspaceWithSkillRoots } from '../../skill';
import { fingerprint } from '../llm-request-logger';
import * as b from '../../tools/builtin';
import type { ToolStore, ToolStoreData, ToolStoreKey } from '../../tools/store';
import type {
  BuiltinTool,
  McpServerRegistrationResult,
  McpToolCollision,
  ToolInfo,
  UserToolRegistration,
} from './types';

export * from './types';

/** Foreground timeout (seconds) for a user-initiated `!` shell command. */
const SHELL_FOREGROUND_TIMEOUT_S = 2 * 60;

interface McpToolEntry {
  readonly tool: ExecutableTool;
  readonly serverName: string;
}

interface PendingMcpDiscovery {
  readonly serverName: string;
  readonly rawTools: readonly MCPToolDefinition[];
  readonly enabledNames: readonly string[];
  readonly collisions: readonly McpToolCollision[];
}

export class ToolManager {
  protected builtinTools: Map<string, BuiltinTool> = new Map();
  protected readonly userTools: Map<string, ExecutableTool> = new Map();
  protected readonly mcpTools: Map<string, McpToolEntry> = new Map();
  private loopToolsOverride: readonly ExecutableTool[] | undefined;
  /** server name → list of qualified tool names registered for that server. */
  protected readonly mcpToolsByServer: Map<string, string[]> = new Map();
  protected enabledTools: Set<string> = new Set();
  /** Glob patterns (e.g. `mcp__*`, `mcp__github__*`) gating which MCP tools the profile exposes. */
  private mcpAccessPatterns: string[] = [];
  /**
   * Defer-window lead for the loaded-tools ledger: names marked loaded whose
   * schema message may still sit in the context's deferred queue (an open tool
   * exchange). The history itself is the source of truth —
   * `loadedDynamicToolNames()` unions this set with a history scan — so
   * undo/compaction/resume never need to roll this back.
   */
  private readonly pendingLoadedDynamicTools = new Set<string>();
  protected readonly store: Partial<ToolStoreData> = {};
  private mcpToolStatusUnsubscribe: (() => void) | undefined;
  /**
   * `serverName\nhash` keys of `mcp.tools_discovered` records already durable
   * in this wire log. Restored on replay; reconnects with an unchanged raw
   * tool list, allow-list, and collision outcome do not re-log.
   */
  private readonly seenMcpDiscoveries = new Set<string>();
  /**
   * Discoveries observed before the record log opened (constructor-time
   * attach can run before `agent.resume()` replays the wire — see
   * `AgentRecords.observabilityReady`). The dedup decision must be re-made at
   * drain time, after replay has restored `seenMcpDiscoveries`.
   */
  private readonly pendingMcpDiscoveries: PendingMcpDiscovery[] = [];
  private mcpDiscoveryDrainSubscribed = false;

  /** Abort controllers for in-flight `!` shell commands, keyed by commandId so
   *  the TUI can cancel (Esc / Ctrl+C) a running command. */
  private readonly shellCommandControllers = new Map<string, AbortController>();

  constructor(protected readonly agent: Agent) {
    this.attachMcpTools();
    if (agent.config.hasProvider) {
      this.initializeBuiltinTools();
    }
  }

  protected get toolStore(): ToolStore {
    return {
      get: (key) => this.store[key],
      set: (key, value) => {
        this.updateStore(key, value);
      },
    };
  }

  attachMcpTools(): void {
    const mcp = this.agent.mcp;
    if (mcp === undefined) return;
    if (this.mcpToolStatusUnsubscribe !== undefined) return;
    for (const entry of mcp.list()) {
      if (entry.status === 'connected') {
        this.registerConnectedMcpServer(mcp, entry);
      } else if (entry.status === 'needs-auth') {
        this.registerNeedsAuthMcpServer(mcp, entry);
      }
    }
    this.mcpToolStatusUnsubscribe = mcp.onStatusChange((entry) => {
      this.handleMcpServerStatusChange(mcp, entry);
    });
  }

  updateStore<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void {
    this.agent.records.logRecord({
      type: 'tools.update_store',
      key,
      value,
    });
    this.store[key] = value;
  }

  /**
   * Execute a user-initiated `!` shell command. Reuses the builtin Bash tool
   * (same kaos / cwd / BackgroundManager as the agent), recording the command
   * and its output as `shell_command`-origin messages. It does NOT start a turn
   * — the model is not prompted (parity with claude-code's `shouldQuery: false`).
   */
  async runShellCommand(
    command: string,
    commandId?: string,
  ): Promise<{ stdout: string; stderr: string; isError?: boolean; backgrounded?: boolean }> {
    this.agent.context.appendBashInput(command);
    const bash = this.builtinTools.get('Bash');
    if (bash === undefined) {
      const error = 'Bash tool is not available.';
      this.agent.context.appendBashOutput('', error);
      return { stdout: '', stderr: error, isError: true };
    }
    let stdout = '';
    let stderr = '';
    let isError: boolean | undefined;
    const controller = new AbortController();
    if (commandId !== undefined) this.shellCommandControllers.set(commandId, controller);
    try {
      const execution = await bash.resolveExecution({ command, timeout: SHELL_FOREGROUND_TIMEOUT_S });
      if (!('execute' in execution)) {
        const output =
          typeof execution.output === 'string' ? execution.output : 'Command failed.';
        this.agent.context.appendBashOutput('', output);
        return { stdout: '', stderr: output, isError: true };
      }
      const result = await execution.execute({
        turnId: '',
        toolCallId: 'shell-command',
        signal: controller.signal,
        onUpdate: (update: ToolUpdate) => {
          if (update.kind === 'stdout') stdout += update.text ?? '';
          else if (update.kind === 'stderr') stderr += update.text ?? '';
          else return;
          // Stream the chunk live to the TUI. Transient event — the final
          // output is still recorded once below for resume.
          if (commandId !== undefined) {
            this.agent.emitEvent({ type: 'shell.output', commandId, update });
          }
        },
        onForegroundTaskStart: (taskId: string) => {
          // Surface the background-task id so the TUI can detach (ctrl+b) it.
          if (commandId !== undefined) {
            this.agent.emitEvent({ type: 'shell.started', commandId, taskId });
          }
        },
      });
      isError = result.isError === true;

      // Detached to background (ctrl+b): the BashTool returns the background
      // metadata (task_id / status / output path) — the same payload a normal
      // foreground Bash call returns as its tool result when backgrounded.
      // Inject it as a user-invisible message and immediately send it to the
      // model (mirrors the background-task completion notification, but hidden).
      if (typeof result.output === 'string' && result.output.startsWith('task_id: ')) {
        this.agent.context.injectAndNotify(result.output, {
          kind: 'injection',
          variant: 'shell_command_backgrounded',
        });
        return { stdout: result.output, stderr: '', isError: false, backgrounded: true };
      }

      // When the command fails with no captured stdout/stderr, the failure
      // reason lives in result.output (non-zero exit with no output, timeout,
      // spawn failure). Surface it as stderr so the TUI and replay show what
      // went wrong instead of "(no output)".
      if (
        isError &&
        stdout.length === 0 &&
        stderr.length === 0 &&
        typeof result.output === 'string' &&
        result.output.length > 0
      ) {
        stderr = result.output;
      }
    } catch (error) {
      stderr += error instanceof Error ? error.message : String(error);
      isError = true;
    } finally {
      if (commandId !== undefined) this.shellCommandControllers.delete(commandId);
    }
    this.agent.context.appendBashOutput(stdout, stderr, isError);
    return { stdout, stderr, isError };
  }

  cancelShellCommand(commandId: string): void {
    this.shellCommandControllers.get(commandId)?.abort();
  }

  registerUserTool(input: UserToolRegistration): void {
    this.agent.records.logRecord({
      type: 'tools.register_user_tool',
      ...input,
    });
    const { name, description, parameters } = input;
    const tool: ExecutableTool = {
      name,
      description,
      parameters,
      resolveExecution: (args) => {
        return {
          approvalRule: name,
          execute: async (context) => {
            return this.agent.rpc!.toolCall!(
              {
                turnId: Number(context.turnId),
                toolCallId: context.toolCallId,
                args,
              },
              { signal: context.signal },
            );
          },
        };
      },
    };
    this.userTools.set(name, tool);
    this.enabledTools.add(name);
  }

  unregisterUserTool(name: string): void {
    this.agent.records.logRecord({
      type: 'tools.unregister_user_tool',
      name,
    });
    this.userTools.delete(name);
    this.enabledTools.delete(name);
  }

  inheritUserTools(parent: ToolManager): void {
    for (const tool of parent.userTools.values()) {
      if (!parent.enabledTools.has(tool.name)) continue;
      this.registerUserTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
  }

  registerMcpServer(
    serverName: string,
    client: MCPClient,
    tools: readonly Tool[],
    enabledTools?: ReadonlySet<string>,
  ): McpServerRegistrationResult {
    this.unregisterMcpServer(serverName);
    const qualifiedNames: string[] = [];
    const collisions: McpToolCollision[] = [];
    const seenInThisCall = new Map<string, string>();
    for (const tool of tools) {
      if (enabledTools !== undefined && !enabledTools.has(tool.name)) continue;
      const qualified = qualifyMcpToolName(serverName, tool.name);
      const firstInThisCall = seenInThisCall.get(qualified);
      if (firstInThisCall !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'same_server', toolName: firstInThisCall },
        });
        continue;
      }
      const existingEntry = this.mcpTools.get(qualified);
      if (existingEntry !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'other_server', serverName: existingEntry.serverName },
        });
        continue;
      }
      seenInThisCall.set(qualified, tool.name);
      const wrapped: ExecutableTool = {
        name: qualified,
        description: tool.description,
        parameters: tool.parameters,
        resolveExecution: (args) => {
          return {
            approvalRule: qualified,
            execute: async (context) => {
              // `args` has already been JSON-parsed and schema-validated by
              // the loop's preflight (`loop/tool-call.ts`), so the MCP
              // client gets a plain object directly.
              const result = await client.callTool(
                tool.name,
                (args ?? {}) as Record<string, unknown>,
                context.signal,
              );
              return mcpResultToExecutableOutput(result, qualified, {
                originalsDir: this.agent.mediaOriginalsDir,
                telemetry: this.agent.telemetry,
                // Resolved per call so a config reload applies immediately.
                maxImageEdgePx: this.agent.imageLimits?.maxEdgePx(),
              });
            },
          };
        },
      };
      this.mcpTools.set(qualified, { tool: wrapped, serverName });
      qualifiedNames.push(qualified);
    }
    this.mcpToolsByServer.set(serverName, qualifiedNames);
    return { registered: qualifiedNames, collisions };
  }

  unregisterMcpServer(serverName: string): boolean {
    const existing = this.mcpToolsByServer.get(serverName);
    if (existing === undefined) return false;
    for (const qualified of existing) {
      this.mcpTools.delete(qualified);
    }
    this.mcpToolsByServer.delete(serverName);
    return true;
  }

  private handleMcpServerStatusChange(mcp: McpConnectionManager, entry: McpServerEntry): void {
    if (entry.status === 'connected') {
      this.registerConnectedMcpServer(mcp, entry);
      return;
    }
    if (entry.status === 'needs-auth') {
      this.registerNeedsAuthMcpServer(mcp, entry);
      return;
    }
    if (entry.status === 'failed') {
      this.unregisterMcpServer(entry.name);
      this.agent.emitEvent({
        type: 'tool.list.updated',
        reason: 'mcp.failed',
        serverName: entry.name,
      });
      return;
    }
    if (entry.status === 'disabled' || entry.status === 'pending') {
      const removed = this.unregisterMcpServer(entry.name);
      if (removed) {
        this.agent.emitEvent({
          type: 'tool.list.updated',
          reason: 'mcp.disconnected',
          serverName: entry.name,
        });
      }
    }
  }

  private registerNeedsAuthMcpServer(mcp: McpConnectionManager, entry: McpServerEntry): void {
    // Replace whatever tools (real or synthetic) were registered before; a
    // server flipping to needs-auth means previous tokens were invalidated.
    this.unregisterMcpServer(entry.name);
    const oauthService = mcp.oauthService;
    const serverUrl = mcp.getRemoteServerUrl(entry.name);
    if (oauthService === undefined || serverUrl === undefined) {
      // Misconfiguration: a server reached needs-auth without the manager
      // owning an OAuth service or being remote. Treat it as a no-op so the
      // existing failure error message keeps the user informed.
      return;
    }
    const tool = createMcpAuthTool({
      serverName: entry.name,
      serverUrl,
      oauthService,
      reconnect: async () => {
        await mcp.reconnect(entry.name);
      },
    });
    this.mcpTools.set(tool.name, { tool, serverName: entry.name });
    this.mcpToolsByServer.set(entry.name, [tool.name]);
    // The synthetic auth tool is now in the tool list; surface it the same way
    // a real toolset would show up so the model picks it up.
    this.agent.emitEvent({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
  }

  private registerConnectedMcpServer(mcp: McpConnectionManager, entry: McpServerEntry): void {
    const resolved = mcp.resolved(entry.name);
    if (resolved === undefined) return;
    const result = this.registerMcpServer(
      entry.name,
      resolved.client,
      resolved.tools,
      resolved.enabledNames,
    );
    this.recordMcpToolsDiscovered(
      entry.name,
      resolved.rawTools,
      resolved.enabledNames,
      result.collisions,
    );
    this.emitMcpToolCollisions(entry.name, result.collisions);
    this.agent.emitEvent({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
  }

  /** Replay: a discovery with this hash is already durable; never re-log it. */
  restoreMcpDiscovery(serverName: string, hash: string): void {
    this.seenMcpDiscoveries.add(`${serverName}\n${hash}`);
  }

  /**
   * Observability record: the server's verbatim `tools/list` result plus how
   * this agent gated it (allow-list, collisions). See `records/types.ts`.
   * Parked while the record log has not opened yet (pre-replay window).
   */
  private recordMcpToolsDiscovered(
    serverName: string,
    rawTools: readonly MCPToolDefinition[],
    enabledNames: ReadonlySet<string>,
    collisions: readonly McpToolCollision[],
  ): void {
    const discovery: PendingMcpDiscovery = {
      serverName,
      rawTools,
      enabledNames: [...enabledNames].toSorted((a, b) => a.localeCompare(b)),
      collisions,
    };
    if (!this.agent.records.observabilityReady) {
      this.pendingMcpDiscoveries.push(discovery);
      // Lazy one-shot subscription: only agents that actually parked need
      // the drain callback, and at park time the log is guaranteed unopened.
      if (!this.mcpDiscoveryDrainSubscribed) {
        this.mcpDiscoveryDrainSubscribed = true;
        this.agent.records.onOpened(() => {
          this.drainPendingMcpDiscoveries();
        });
      }
      return;
    }
    this.writeMcpDiscovery(discovery);
  }

  private drainPendingMcpDiscoveries(): void {
    const pending = this.pendingMcpDiscoveries.splice(0);
    for (const discovery of pending) {
      this.writeMcpDiscovery(discovery);
    }
  }

  private writeMcpDiscovery(discovery: PendingMcpDiscovery): void {
    const { serverName, rawTools, enabledNames, collisions } = discovery;
    // The hash covers everything the record captures — the raw list, the
    // allow-list, AND the collision outcome. Collisions depend on which
    // other servers hold a qualified name at registration time, so the same
    // server can re-register with identical tools but a different outcome;
    // that change must produce a new record.
    const hash = fingerprint(JSON.stringify({ tools: rawTools, enabledNames, collisions }));
    const key = `${serverName}\n${hash}`;
    if (this.seenMcpDiscoveries.has(key)) return;
    this.seenMcpDiscoveries.add(key);
    this.agent.records.logRecord({
      type: 'mcp.tools_discovered',
      serverName,
      hash,
      tools: rawTools,
      enabledNames,
      collisions: collisions.length > 0 ? collisions : undefined,
    });
  }

  private emitMcpToolCollisions(serverName: string, collisions: readonly McpToolCollision[]): void {
    if (collisions.length === 0) return;
    const summary = collisions
      .map((c) =>
        c.collidesWith.kind === 'same_server'
          ? `"${c.toolName}" -> ${c.qualified} (collides with "${c.collidesWith.toolName}" from the same server)`
          : `"${c.toolName}" -> ${c.qualified} (collides with server "${c.collidesWith.serverName}")`,
      )
      .join('; ');
    this.agent.emitEvent({
      type: 'error',
      ...makeErrorPayload(
        'mcp.tool_name_collision',
        `MCP server "${serverName}" registered ${collisions.length} tool name` +
          `${collisions.length === 1 ? '' : 's'} ` +
          `that collide with existing qualified names; the losing tools were dropped: ${summary}`,
        { details: { serverName, collisions: collisions as readonly unknown[] } },
      ),
    });
  }

  setActiveTools(names: readonly string[]): void {
    this.agent.records.logRecord({
      type: 'tools.set_active_tools',
      names,
    });
    // MCP entries are glob patterns gated separately; the rest are exact
    // builtin/user tool names. The split keeps every caller on one string[].
    this.enabledTools = new Set(names.filter((name) => !isMcpToolName(name)));
    this.mcpAccessPatterns = names.filter((name) => isMcpToolName(name));
    // Builtin construction reads the enabled set (Bash/Agent bake
    // `allowBackground` from the Task* trio), and the constructor may already
    // have built the map while the enabled set was still empty. The lazy
    // re-init in `get tools()` only fires on an empty map, so rebuild here —
    // otherwise a profile applied after construction (every subagent) keeps
    // the construction-time capabilities.
    if (this.agent.config.hasProvider) {
      this.initializeBuiltinTools();
    }
  }

  copyLoopToolsFrom(source: ToolManager): void {
    this.loopToolsOverride = source.loopTools;
  }

  private isMcpToolEnabled(name: string): boolean {
    return this.mcpAccessPatterns.some((pattern) => picomatch.isMatch(name, pattern));
  }

  /**
   * Whether MCP tools are disclosed progressively: kept out of the top-level
   * `tools[]` and loaded on demand via select_tools. Reads the agent's single
   * three-gate decision point.
   */
  private get progressiveDisclosure(): boolean {
    return this.agent.toolSelectEnabled;
  }

  /**
   * Names the model may select right now: registered MCP tools that pass the
   * profile's `mcp__*` access patterns, sorted for byte-stable announcements.
   * In disclosure mode the patterns keep their permission-filter role but stop
   * feeding the top-level `tools[]`.
   */
  loadableDynamicToolNames(): string[] {
    return [...this.mcpTools.keys()]
      .filter((name) => this.isMcpToolEnabled(name))
      .toSorted((a, b) => a.localeCompare(b));
  }

  /**
   * The loaded-tools ledger: every name whose full definition has been
   * delivered to the conversation via a `tools`-carrying message, plus the
   * defer-window pending set. History is the single source of truth, so the
   * ledger survives resume (records replay rebuilds the history), keeps its
   * state across undo (schema messages have `injection` origin and are not
   * undone), and empties at compaction (schema messages are discarded with
   * the folded history — the model re-selects what it still needs).
   */
  loadedDynamicToolNames(): ReadonlySet<string> {
    const names = collectLoadedDynamicToolNames(this.agent.context.history);
    for (const name of this.pendingLoadedDynamicTools) names.add(name);
    return names;
  }

  /** Mark names loaded ahead of their schema message landing in history. */
  markDynamicToolsLoaded(names: Iterable<string>): void {
    for (const name of names) this.pendingLoadedDynamicTools.add(name);
  }

  /**
   * Context was cleared (`/clear`): every schema message is gone, so the
   * defer-window lead must not keep reporting its names as loaded — a stale
   * entry would make select_tools answer "Already available" for a tool whose
   * definition the model can no longer see.
   */
  onContextCleared(): void {
    this.pendingLoadedDynamicTools.clear();
  }

  /**
   * Compaction rebuilt the history and discarded every loaded schema with it
   * — the loaded set is empty from here on. A pending entry surviving past
   * this boundary would report a schema the context no longer carries as
   * loaded, and re-selecting it would wrongly answer "Already available"
   * instead of injecting.
   */
  onContextCompacted(): void {
    this.pendingLoadedDynamicTools.clear();
  }

  /**
   * Plain schema snapshot of a registered MCP tool, read from the live
   * registry (never from history) at injection time.
   */
  getMcpToolSchema(name: string): Tool | undefined {
    const entry = this.mcpTools.get(name);
    if (entry === undefined) return undefined;
    return {
      name: entry.tool.name,
      description: entry.tool.description,
      parameters: entry.tool.parameters,
    };
  }

  /**
   * Disclosure-mode wording for a tool-call preflight miss. A loaded tool
   * whose server dropped is a different situation from a never-announced name;
   * telling them apart stops the model from re-selecting a disconnected tool
   * in a loop or treating a transient disconnect as a permanent removal.
   */
  missingToolMessage(name: string): string | undefined {
    if (!this.progressiveDisclosure) return undefined;
    if (!isMcpToolName(name)) return undefined;
    const registered = this.mcpTools.has(name) && this.isMcpToolEnabled(name);
    const loaded = this.loadedDynamicToolNames().has(name);
    if (registered && !loaded) {
      return (
        `Tool "${name}" is available but not loaded. ` +
        `Call select_tools with ["${name}"] first, then call the tool.`
      );
    }
    if (!registered && loaded) {
      return (
        `Tool "${name}" was loaded but its MCP server is currently disconnected. ` +
        'It may become available again when the server reconnects; do not retry immediately.'
      );
    }
    return undefined;
  }

  *toolInfos(): Iterable<ToolInfo> {
    for (const tool of this.builtinTools.values()) {
      yield {
        name: tool.name,
        description: tool.description,
        // select_tools is always registered but only offered while the
        // disclosure gate is open (see loopTools); report that live state.
        active:
          this.enabledTools.has(tool.name) ||
          (tool.name === b.SELECT_TOOLS_TOOL_NAME && this.agent.toolSelectEnabled),
        source: 'builtin',
      };
    }
    for (const tool of this.userTools.values()) {
      yield {
        name: tool.name,
        description: tool.description,
        active: this.enabledTools.has(tool.name),
        source: 'user',
      };
    }
    for (const entry of this.mcpTools.values()) {
      yield {
        name: entry.tool.name,
        description: entry.tool.description,
        active: this.isMcpToolEnabled(entry.tool.name),
        source: 'mcp',
      };
    }
  }

  data(): readonly ToolInfo[] {
    return Array.from(this.toolInfos());
  }

  storeData(): Readonly<Record<string, unknown>> {
    return { ...this.store };
  }

  initializeBuiltinTools() {
    const {
      kaos,
      toolServices,
      config: { cwd, provider, modelCapabilities },
      background,
    } = this.agent;
    const videoUploader = this.createVideoUploader(provider);
    const workspace = extendWorkspaceWithSkillRoots(
      {
        workspaceDir: cwd,
        additionalDirs: this.agent.getAdditionalDirs(),
      },
      this.agent.skills?.registry.getSkillRoots() ?? [],
    );
    const allowBackground =
      this.enabledTools.has('TaskList') &&
      this.enabledTools.has('TaskOutput') &&
      this.enabledTools.has('TaskStop');
    const goalToolsEnabled = this.agent.type === 'main';
    this.builtinTools = new Map(
      [
        new b.ReadTool(kaos, workspace),
        new b.WriteTool(kaos, workspace),
        new b.EditTool(kaos, workspace),
        new b.GrepTool(kaos, workspace, this.agent.telemetry),
        new b.GlobTool(kaos, workspace, this.agent.telemetry),
        new b.BashTool(kaos, cwd, background, {
          allowBackground,
          autoBackgroundOnTimeout:
            this.agent.kimiConfig?.background?.bashAutoBackgroundOnTimeout ?? true,
          backgroundTimeoutS: this.agent.kimiConfig?.background?.bashTaskTimeoutS,
        }),
        (modelCapabilities.image_in || modelCapabilities.video_in) &&
          new b.ReadMediaFileTool(
            kaos,
            workspace,
            modelCapabilities,
            videoUploader,
            this.agent.telemetry,
            this.agent.imageLimits,
          ),
        new b.EnterPlanModeTool(this.agent),
        new b.ExitPlanModeTool(this.agent),
        // Registered unconditionally: the tool-select flag can flip at runtime
        // (config reload calls setConfigOverrides) without this method
        // re-running, so registration must not depend on the gate — exposure
        // is decided per step in loopTools instead. Deliberately not
        // main-only: subagents run their own disclosure and need select_tools
        // just as much.
        new b.SelectToolsTool(this.agent),
        // Goal tools are main-agent-only.
        goalToolsEnabled && new b.CreateGoalTool(this.agent),
        goalToolsEnabled && new b.GetGoalTool(this.agent),
        goalToolsEnabled && new b.SetGoalBudgetTool(this.agent),
        goalToolsEnabled && new b.UpdateGoalTool(this.agent),
        this.agent.rpc?.requestQuestion && new b.AskUserQuestionTool(this.agent),
        new b.TodoListTool(this.toolStore),
        new b.TaskListTool(background),
        new b.TaskOutputTool(background),
        new b.TaskStopTool(background),
        this.agent.cron && new b.CronCreateTool(this.agent.cron),
        this.agent.cron && new b.CronListTool(this.agent.cron),
        this.agent.cron && new b.CronDeleteTool(this.agent.cron),
        this.agent.skills?.registry.listInvocableSkills().length &&
          new b.SkillTool(this.agent),
        this.agent.subagentHost &&
          new b.AgentTool(
            this.agent.subagentHost,
            background,
            DEFAULT_AGENT_PROFILES['agent']?.subagents,
            {
              allowBackground,
              log: this.agent.log,
              subagentTimeoutMs: resolveSubagentTimeoutMs(this.agent.kimiConfig?.subagent?.timeoutMs),
            },
          ),
        this.agent.subagentHost &&
          new b.AgentSwarmTool(
            this.agent.subagentHost,
            this.agent.swarmMode,
            resolveSubagentTimeoutMs(this.agent.kimiConfig?.subagent?.timeoutMs),
          ),
        toolServices?.webSearcher && new b.WebSearchTool(toolServices.webSearcher),
        toolServices?.urlFetcher && new b.FetchURLTool(toolServices.urlFetcher),
      ]
        .filter((tool) => !!tool)
        .map((tool) => [tool.name, tool] as const),
    );
  }

  refreshBuiltinTools(): void {
    this.initializeBuiltinTools();
  }

  /**
   * Uploader bound to the agent's current provider, for media that arrives
   * outside a tool call (e.g. a video attached to a prompt). `undefined`
   * when no model is bound or the provider has no video upload channel.
   */
  videoUploader(): b.VideoUploader | undefined {
    if (!this.agent.config.hasProvider) return undefined;
    return this.createVideoUploader(this.agent.config.provider);
  }

  private createVideoUploader(provider: ChatProvider): b.VideoUploader | undefined {
    const uploadVideo = provider.uploadVideo?.bind(provider);
    if (uploadVideo === undefined) return undefined;

    const modelAlias = this.agent.config.modelAlias!;
    const withAuth = this.agent.modelProvider?.resolveAuth?.(modelAlias, {
      log: this.agent.log,
    });
    const baseProps = this.videoUploadTelemetryProps(modelAlias);
    const upload =
      withAuth === undefined
        ? (input: b.VideoUploadInput, signal?: AbortSignal) => uploadVideo(input, { signal })
        : (input: b.VideoUploadInput, signal?: AbortSignal) =>
            withAuth((auth) => uploadVideo(input, { auth, signal }));

    return async (input, options) => {
      const startedAt = Date.now();
      const base = {
        ...baseProps,
        mime_type: input.mimeType,
        size_bytes: input.data.length,
      };
      const track = (props: Record<string, string | number | boolean | undefined>): void => {
        try {
          this.agent.telemetry.track('video_upload', props);
        } catch {
          // Telemetry must never affect the upload outcome.
        }
      };
      try {
        const part = await upload(input, options?.signal);
        track({ ...base, outcome: 'success', duration_ms: Date.now() - startedAt });
        return part;
      } catch (error) {
        track({
          ...base,
          outcome: 'error',
          duration_ms: Date.now() - startedAt,
          error_type: error instanceof Error ? error.name : 'Unknown',
        });
        throw error;
      }
    };
  }

  private videoUploadTelemetryProps(modelAlias: string): {
    provider_type?: string;
    protocol?: string;
    model: string;
  } {
    try {
      const resolved = this.agent.modelProvider?.resolveProviderConfig(modelAlias);
      if (resolved === undefined) return { model: modelAlias };
      return {
        model: modelAlias,
        provider_type: resolved.type,
        protocol: resolved.protocol ?? resolved.type,
      };
    } catch {
      return { model: modelAlias };
    }
  }

  get loopTools(): readonly ExecutableTool[] {
    if (this.loopToolsOverride !== undefined) return this.loopToolsOverride;
    // Self-heal an empty builtin table. The constructor and every config-
    // mutation checkpoint gate initializeBuiltinTools() on hasProvider, but a
    // provider that becomes resolvable asynchronously (OAuth / managed
    // free-tokens model registration) trips none of them — without this the
    // agent runs with zero tools while the system prompt still advertises them.
    // loopTools is re-read before every step, so the table is populated on the
    // first step after the provider resolves. Steady state short-circuits on
    // `builtinTools.size === 0`, so hasProvider is not evaluated per read.
    if (this.builtinTools.size === 0 && this.agent.config.hasProvider) {
      try {
        this.initializeBuiltinTools();
      } catch (error) {
        this.agent.log.warn('lazy initializeBuiltinTools failed; will retry on next read', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const disclosure = this.progressiveDisclosure;
    const enabledMcpNames = [...this.mcpTools.keys()].filter((name) =>
      this.isMcpToolEnabled(name),
    );
    // Progressive disclosure splits "the model can see this tool" from "the
    // core can execute it": the top-level request view stays the immutable
    // core set + select_tools, while loaded MCP tools join the executable
    // table as deferred extras — dispatchable, but stripped from the outbound
    // top-level tools[] by kosong generate(). With disclosure off this is the
    // inline behavior, byte for byte.
    const loadedSet = disclosure ? this.loadedDynamicToolNames() : undefined;
    const mcpNames =
      loadedSet === undefined
        ? enabledMcpNames
        : enabledMcpNames.filter((name) => loadedSet.has(name));
    const selectToolsName = disclosure ? [b.SELECT_TOOLS_TOOL_NAME] : [];
    return uniq([...this.enabledTools, ...selectToolsName, ...mcpNames])
      .toSorted((a, b) => a.localeCompare(b))
      // select_tools is exposed exclusively through the disclosure gate — a
      // profile or setActiveTools listing the name explicitly must not
      // surface it in inline mode (it was silently dropped back when
      // registration itself was gated; keep that contract).
      .filter((name) => disclosure || name !== b.SELECT_TOOLS_TOOL_NAME)
      .map((name) => {
        const tool =
          this.userTools.get(name) ??
          this.mcpTools.get(name)?.tool ??
          this.builtinTools.get(name);
        if (tool === undefined) return undefined;
        // MCP entries are plain object literals, so the spread keeps the
        // execution closure intact while adding the wire-strip marker.
        return disclosure && this.mcpTools.has(name) ? { ...tool, deferred: true as const } : tool;
      })
      .filter((tool) => !!tool);
  }
}
