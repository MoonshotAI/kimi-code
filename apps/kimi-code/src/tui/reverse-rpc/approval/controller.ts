import type { ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import { ReverseRpcController } from '#/tui/reverse-rpc/base-controller';
import type { ApprovalPanelData } from '#/tui/reverse-rpc/types';

export class ApprovalController extends ReverseRpcController<
  ApprovalPanelData,
  ApprovalResponse
> {
  protected createCancelResponse(reason: string): ApprovalResponse {
    return { decision: 'cancelled', feedback: reason };
  }

  protected override autoResolveFor(
    resolvedPayload: ApprovalPanelData,
    response: ApprovalResponse,
    queuedPayload: ApprovalPanelData,
  ): ApprovalResponse | undefined {
    if (response.decision !== 'approved') return undefined;
    if (response.scope !== 'session') return undefined;
    if (resolvedPayload.action !== queuedPayload.action) return undefined;
    return { decision: 'approved', scope: 'session' };
  }
}
