/**
 * `password` domain (L7) — `ISessionPasswordService` implementation.
 *
 * Typed facade over the `interaction` kernel for password requests; owns no
 * pending state of its own (the kernel holds it). Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionInteractionService } from '#/session/interaction/interaction';

import {
  type PasswordRequest,
  type PasswordResponse,
  ISessionPasswordService,
} from './password';

export class SessionPasswordService implements ISessionPasswordService {
  declare readonly _serviceBrand: undefined;

  private nextId = 0;

  constructor(@ISessionInteractionService private readonly interaction: ISessionInteractionService) {}

  request(req: PasswordRequest): Promise<PasswordResponse> {
    const id = this.requestId(req);
    return this.interaction.request<PasswordRequest, PasswordResponse>({
      id,
      kind: 'password',
      payload: { ...req, id },
      origin: { agentId: req.agentId, turnId: req.turnId },
    });
  }

  enqueue(req: PasswordRequest): PasswordRequest & { readonly id: string } {
    const id = this.requestId(req);
    this.interaction.enqueue<PasswordRequest>({
      id,
      kind: 'password',
      payload: { ...req, id },
      origin: { agentId: req.agentId, turnId: req.turnId },
    });
    return { ...req, id };
  }

  resolve(id: string, response: PasswordResponse): void {
    this.interaction.respond(id, response);
  }

  listPending(): readonly PasswordRequest[] {
    return this.interaction
      .listPending('password')
      .map((i) => i.payload as PasswordRequest);
  }

  private requestId(req: PasswordRequest): string {
    return req.id ?? `password:${String(Date.now())}:${String(this.nextId++)}`;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionPasswordService,
  SessionPasswordService,
  InstantiationType.Eager,
  'password',
);
