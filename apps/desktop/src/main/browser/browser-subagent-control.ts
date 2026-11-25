import type { BrowserController, BrowserSubagentRun } from '../../shared/browser-run';
import { BrowserControlError } from './browser-control-ownership';

export const DESKTOP_BROWSER_SUBAGENT_RUN_REASON = 'This subagent run is not currently running with built-in browser control enabled, so `mcp__desktop_browser__run` is unavailable.';

export interface DesktopBrowserSubagentRun extends BrowserController {
  assertActive(): void;
}

export interface BrowserSubagentAgentState {
  readonly running: boolean;
  readonly turnId?: number;
  readonly profile?: string;
  readonly eligible: boolean;
}

export interface BrowserSubagentAgent {
  readonly agentId: string;
  readonly generation: number;
  state(): BrowserSubagentAgentState;
}

interface AgentEntry {
  readonly agent: BrowserSubagentAgent;
  description?: string;
}

function key(sessionId: string, run: BrowserSubagentRun): string {
  return JSON.stringify([sessionId, run.agentId, run.generation, run.turnId]);
}

function agentKey(sessionId: string, agentId: string): string {
  return JSON.stringify([sessionId, agentId]);
}

function displayText(value: string | undefined): string | undefined {
  const text = value?.trim().slice(0, 500);
  return text ? text : undefined;
}

export class BrowserSubagentRunRegistry {
  private readonly agents = new Map<string, AgentEntry>();
  private readonly leased = new Map<string, { sessionId: string; run: BrowserSubagentRun }>();
  private readonly listeners = new Set<(sessionId: string, run: BrowserSubagentRun) => void>();

  constructor(private readonly enabled: () => boolean) {}

  attach(sessionId: string, agent: BrowserSubagentAgent): void {
    this.agents.set(agentKey(sessionId, agent.agentId), { agent });
  }

  describe(sessionId: string, agentId: string, generation: number, description: string | undefined): void {
    const entry = this.agents.get(agentKey(sessionId, agentId));
    if (entry?.agent.generation === generation) entry.description = description;
  }

  resolve(sessionId: string, run: BrowserSubagentRun): DesktopBrowserSubagentRun | null {
    if (!this.enabled()) return null;
    const entry = this.agents.get(agentKey(sessionId, run.agentId));
    const state = entry?.agent.generation === run.generation ? entry.agent.state() : undefined;
    if (entry === undefined || state?.eligible !== true || !state.running || state.turnId !== run.turnId) {
      this.finish(sessionId, run);
      return null;
    }
    const identity = { agentId: run.agentId, generation: run.generation, turnId: run.turnId };
    const profile = displayText(state.profile);
    const description = displayText(entry.description);
    this.leased.set(key(sessionId, identity), { sessionId, run: identity });
    return {
      run: identity,
      profile,
      description,
      assertActive: () => {
        if (this.resolve(sessionId, identity) === null) {
          throw new BrowserControlError('BROWSER_SUBAGENT_UNAVAILABLE', DESKTOP_BROWSER_SUBAGENT_RUN_REASON);
        }
      },
    };
  }

  finish(sessionId: string, run: BrowserSubagentRun): void {
    const leaseKey = key(sessionId, run);
    if (!this.leased.delete(leaseKey)) return;
    for (const listener of Array.from(this.listeners)) listener(sessionId, run);
  }

  closeAgent(sessionId: string, agentId: string, generation: number): void {
    this.agents.delete(agentKey(sessionId, agentId));
    for (const lease of Array.from(this.leased.values())) {
      if (lease.sessionId === sessionId && lease.run.agentId === agentId && lease.run.generation === generation) {
        this.finish(sessionId, lease.run);
      }
    }
  }

  closeSession(sessionId: string): void {
    for (const lease of Array.from(this.leased.values())) if (lease.sessionId === sessionId) this.finish(sessionId, lease.run);
    for (const entryKey of this.agents.keys()) {
      const [owner] = JSON.parse(entryKey) as [string];
      if (owner === sessionId) this.agents.delete(entryKey);
    }
  }

  revokeAll(): void {
    for (const lease of Array.from(this.leased.values())) this.finish(lease.sessionId, lease.run);
  }

  onDidRevoke(listener: (sessionId: string, run: BrowserSubagentRun) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
