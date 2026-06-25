import { createDecorator } from "#/_base/di";

export interface ITodoListService {
  readonly _serviceBrand: undefined;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITodoListService = createDecorator<ITodoListService>('agentTodoListService');
