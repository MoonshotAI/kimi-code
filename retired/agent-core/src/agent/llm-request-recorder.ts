/**
 * Durable request-trace recorder: writes the observability records
 * (`llm.tools_snapshot`, `llm.request`) that make every outbound model
 * request reconstructable from the wire log. Called from the single
 * `Agent.generate` choke point, so loop steps, retry attempts, strict
 * resends, and compaction rounds all leave a trace.
 *
 * Sibling of `LlmRequestLogger` (diagnostic log lines, hashes only); this
 * class owns the wire-record side. See the observability-records note in
 * `records/types.ts` for the persistence contract.
 */

import { KimiChatProvider, type ChatProvider, type Message, type Tool } from '@moonshot-ai/kosong';

import { parseFloatEnv } from '#/config/resolve';
import { resolveThinkingKeep } from '#/config/kimi-env-params';

import type { Agent } from '.';
import type { LLMRequestLogFields } from '../loop';
import { fingerprint, toolSignature } from './llm-request-logger';

export class LlmRequestRecorder {
  /** Hashes of tool tables already durable in this wire log. */
  private readonly seenToolsHashes = new Set<string>();
  /**
   * Identity cache over the last wire tool table. Tool instances are treated
   * as immutable and are stable across steps (rebuilt only by
   * `initializeBuiltinTools` / MCP re-registration), so element-wise identity
   * implies content equality — the common per-step path costs no hashing.
   */
  private lastWireTools: readonly Tool[] | undefined;
  private lastToolsHash: string | undefined;
  private lastSystemPrompt: string | undefined;
  private lastSystemPromptHash: string | undefined;

  constructor(private readonly agent: Agent) {}

  /** Replay: a snapshot with this hash is already durable; never re-log it. */
  restoreToolsSnapshot(hash: string): void {
    this.seenToolsHashes.add(hash);
  }

  record(input: {
    readonly provider: ChatProvider;
    readonly systemPrompt: string;
    readonly tools: readonly Tool[];
    readonly messages: readonly Message[];
    readonly fields: LLMRequestLogFields | undefined;
  }): void {
    const { provider, systemPrompt, messages } = input;
    const fields = input.fields ?? {};
    // Deferred tools are stripped by kosong generate() before the provider
    // sees them; snapshot what actually goes on the wire. In disclosure mode
    // this keeps the snapshot byte-stable across select_tools loads.
    const wireTools = input.tools.filter((tool) => tool.deferred !== true);
    const toolsHash = this.toolsHashFor(wireTools);
    if (!this.seenToolsHashes.has(toolsHash)) {
      this.seenToolsHashes.add(toolsHash);
      this.agent.records.logRecord({
        type: 'llm.tools_snapshot',
        hash: toolsHash,
        tools: toolSignature(wireTools),
      });
    }

    const modelAlias = this.agent.config.modelAlias;
    // Mirror the ConfigState.provider pipeline for Kimi-only request params:
    // env sampling overrides and the preserved-thinking keep passthrough
    // reach the wire only for Kimi providers, resolved by the same exported
    // helpers used at construction. thinkingEffort needs no mirroring — the
    // Kimi provider derives it from the request body's thinking payload, so
    // env effort overrides are already reflected in the read value.
    const isKimiProvider = provider instanceof KimiChatProvider;
    this.agent.records.logRecord({
      type: 'llm.request',
      kind: fields.kind ?? 'loop',
      provider: provider.name,
      model: provider.modelName,
      modelAlias,
      thinkingEffort: provider.thinkingEffort ?? undefined,
      thinkingKeep: isKimiProvider
        ? resolveThinkingKeep(
            process.env,
            this.agent.kimiConfig?.thinking?.keep,
            provider.thinkingEffort ?? 'off',
          )
        : undefined,
      temperature: isKimiProvider
        ? parseFloatEnv(process.env['KIMI_MODEL_TEMPERATURE'], 'KIMI_MODEL_TEMPERATURE')
        : undefined,
      topP: isKimiProvider
        ? parseFloatEnv(process.env['KIMI_MODEL_TOP_P'], 'KIMI_MODEL_TOP_P')
        : undefined,
      maxTokens: provider.maxCompletionTokens,
      betaApi:
        modelAlias === undefined
          ? undefined
          : this.agent.kimiConfig?.models?.[modelAlias]?.betaApi,
      toolSelect: this.agent.toolSelectEnabled,
      systemPromptHash: this.systemPromptHashFor(systemPrompt),
      systemPrompt:
        systemPrompt === this.agent.config.systemPrompt ? undefined : systemPrompt,
      toolsHash,
      messageCount: messages.length,
      turnStep: fields.turnStep,
      attempt: fields.attempt,
      projection: fields.projection,
      droppedCount: fields.droppedCount,
    });
  }

  private toolsHashFor(wireTools: readonly Tool[]): string {
    if (this.lastToolsHash !== undefined && sameToolInstances(this.lastWireTools, wireTools)) {
      return this.lastToolsHash;
    }
    const hash = fingerprint(JSON.stringify(toolSignature(wireTools)));
    this.lastWireTools = wireTools;
    this.lastToolsHash = hash;
    return hash;
  }

  private systemPromptHashFor(systemPrompt: string): string {
    if (this.lastSystemPromptHash === undefined || systemPrompt !== this.lastSystemPrompt) {
      this.lastSystemPrompt = systemPrompt;
      this.lastSystemPromptHash = fingerprint(systemPrompt);
    }
    return this.lastSystemPromptHash;
  }
}

function sameToolInstances(
  previous: readonly Tool[] | undefined,
  current: readonly Tool[],
): boolean {
  if (previous === undefined || previous.length !== current.length) return false;
  for (let i = 0; i < current.length; i++) {
    if (previous[i] !== current[i]) return false;
  }
  return true;
}
