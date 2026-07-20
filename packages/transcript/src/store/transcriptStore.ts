/**
 * TranscriptStore — the session-level root.
 *
 * Owns one AgentTranscript per agent, created lazily. Per-agent granularity
 * subscriptions are a transport (L3) concern and deliberately absent here;
 * this layer only guarantees that an agent's transcript exists on demand and
 * that roster changes are observable (so the server can fan out, and clients
 * can render an agent picker).
 */

import type { AgentId } from '../model/ids';
import { AgentTranscript, type Disposable } from './agentTranscript';

export interface AgentDescriptor {
  readonly agentId: AgentId;
  /** Engine metadata, mirrored for display (e.g. 'main' | 'sub' | swarm member). */
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: AgentId;
  readonly label?: string;
  readonly createdAt?: string;
}

export type RosterListener = (agents: readonly AgentDescriptor[]) => void;

export class TranscriptStore {
  readonly #agents = new Map<AgentId, AgentTranscript>();
  readonly #descriptors = new Map<AgentId, AgentDescriptor>();
  readonly #rosterListeners = new Set<RosterListener>();

  constructor(readonly sessionId: string) {}

  /** Lazily create (or fetch) the transcript for an agent. */
  ensureAgent(agentId: AgentId, descriptor?: AgentDescriptor): AgentTranscript {
    let transcript = this.#agents.get(agentId);
    if (!transcript) {
      transcript = new AgentTranscript(agentId);
      this.#agents.set(agentId, transcript);
    }
    if (descriptor && this.#descriptors.get(agentId) !== descriptor) {
      this.#descriptors.set(agentId, descriptor);
      this.#emitRoster();
    }
    return transcript;
  }

  getAgent(agentId: AgentId): AgentTranscript | undefined {
    return this.#agents.get(agentId);
  }

  /** Drop an agent entirely (disposed sub-agent, swarm member cleaned up). */
  removeAgent(agentId: AgentId): boolean {
    const removed = this.#agents.delete(agentId);
    if (this.#descriptors.delete(agentId) || removed) this.#emitRoster();
    return removed;
  }

  /** Merge or replace an agent's roster descriptor. */
  describeAgent(descriptor: AgentDescriptor): void {
    if (this.#descriptors.get(descriptor.agentId) !== descriptor) {
      this.#descriptors.set(descriptor.agentId, descriptor);
      this.#emitRoster();
    }
  }

  agents(): readonly AgentDescriptor[] {
    return [...this.#descriptors.values()];
  }

  onRosterChange(listener: RosterListener): Disposable {
    this.#rosterListeners.add(listener);
    return { dispose: () => void this.#rosterListeners.delete(listener) };
  }

  #emitRoster(): void {
    const agents = this.agents();
    for (const listener of this.#rosterListeners) listener(agents);
  }
}
