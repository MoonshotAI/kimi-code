import { createDecorator } from "#/_base/di";
import type { Message } from '@moonshot-ai/kosong';

import type { ContextMessage } from '../types';

export { renderNotificationXml } from '../../../agent/context/notification-xml';
export { project } from '../../../agent/context/projector';

export interface IContextProjector {
  project(messages: readonly ContextMessage[]): readonly Message[];
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IContextProjector = createDecorator<IContextProjector>(
  'agentContextProjectorService',
);
