import { createToken, type UnitNode } from '#/kernel/index';

export const AppNodeRef = createToken<UnitNode>('app.node');

export const SessionNodeRef = createToken<UnitNode>('session.node');

export const AgentNodeRef = createToken<UnitNode>('agent.node');
