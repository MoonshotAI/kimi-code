import type { Scope } from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../protocol/envelope';
import { mapError, withTimeout } from './errors';
import type { RouteHost } from './serviceDispatcherRoutes';
import {
  agentRuntimeBindingSnapshot,
  sessionWorkspaceAssociation,
  workspaceSnapshot,
  workspaceSnapshots,
} from './businessSnapshotDispatcher';

interface SnapshotRequest {
  readonly id: string;
  readonly params: unknown;
}

interface SnapshotReply {
  send(payload: unknown): unknown;
}

export function registerBusinessSnapshotRoutes(
  app: RouteHost,
  core: Scope,
  basePath: string,
  callTimeoutMs = 30_000,
): void {
  app.get(`${basePath}/workspaces`, async (req, reply) =>
    sendSnapshot(req, reply, () => workspaceSnapshots(core), callTimeoutMs));
  app.get(`${basePath}/workspace/:workspace_id/snapshot`, async (req, reply) =>
    sendSnapshot(
      req,
      reply,
      () => workspaceSnapshot(core, requestParams(req)['workspace_id'] ?? ''),
      callTimeoutMs,
    ));
  app.get(`${basePath}/session/:session_id/association`, async (req, reply) =>
    sendSnapshot(
      req,
      reply,
      () => sessionWorkspaceAssociation(core, requestParams(req)['session_id'] ?? ''),
      callTimeoutMs,
    ));
  app.get(`${basePath}/session/:session_id/agent/:agent_id/runtime-binding`, async (req, reply) =>
    sendSnapshot(
      req,
      reply,
      () => agentRuntimeBindingSnapshot(
        core,
        requestParams(req)['session_id'] ?? '',
        requestParams(req)['agent_id'] ?? '',
      ),
      callTimeoutMs,
    ));
}

function requestParams(req: SnapshotRequest): Record<string, string> {
  return req.params as Record<string, string>;
}

async function sendSnapshot(
  req: SnapshotRequest,
  reply: SnapshotReply,
  read: () => unknown,
  callTimeoutMs: number,
): Promise<unknown> {
  try {
    return reply.send(okEnvelope(await withTimeout(Promise.resolve(read()), callTimeoutMs), req.id));
  } catch (error) {
    return reply.send(mapError(error, req.id));
  }
}
