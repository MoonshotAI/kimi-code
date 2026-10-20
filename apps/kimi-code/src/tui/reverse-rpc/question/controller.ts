import { ReverseRpcController } from '#/tui/reverse-rpc/base-controller';
import type { QuestionPanelData, QuestionPanelResponse } from '#/tui/reverse-rpc/types';

export class QuestionController extends ReverseRpcController<
  QuestionPanelData,
  QuestionPanelResponse
> {
  protected createCancelResponse(_reason: string): QuestionPanelResponse {
    return { answers: [] };
  }
}
