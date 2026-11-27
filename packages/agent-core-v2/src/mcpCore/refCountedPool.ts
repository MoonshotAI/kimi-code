import { mcpServerConfigsEqual, type McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';

export class RefCountedMcpServerPool {
  private readonly holders = new Map<string, Map<string, McpServerConfig>>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly manager: McpConnectionManager) {}

  acquire(ownerId: string, servers: Readonly<Record<string, McpServerConfig>>): Promise<void> {
    return this.enqueue(() => this.reconcile(ownerId, servers));
  }

  release(ownerId: string): Promise<void> {
    return this.enqueue(() => this.reconcile(ownerId, {}));
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tail.catch(() => undefined).then(work);
    this.tail = next;
    return next;
  }

  private async reconcile(
    ownerId: string,
    servers: Readonly<Record<string, McpServerConfig>>,
  ): Promise<void> {
    const nextNames = new Set(Object.keys(servers));
    for (const [name, owners] of this.holders.entries()) {
      if (!owners.has(ownerId) || nextNames.has(name)) continue;
      owners.delete(ownerId);
      if (owners.size > 0) continue;
      this.holders.delete(name);
      await this.manager.remove(name);
    }
    const pending: Promise<void>[] = [];
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;
      const owners = this.holders.get(name) ?? new Map<string, McpServerConfig>();
      const previous = owners.values().next().value;
      owners.set(ownerId, config);
      this.holders.set(name, owners);
      const existing = this.manager.get(name);
      if (
        previous !== undefined &&
        existing !== undefined &&
        existing.status !== 'removed' &&
        existing.status !== 'disabled' &&
        mcpServerConfigsEqual(previous, config)
      ) {
        continue;
      }
      pending.push(this.manager.connect(name, config));
    }
    await Promise.allSettled(pending);
  }
}
