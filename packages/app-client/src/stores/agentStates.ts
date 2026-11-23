import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppAgentState, AppAgentUsage, AppTodoItem } from '@moonshot-ai/app-core/api';
import { clientPinia } from './pinia';

const NO_TODOS: readonly AppTodoItem[] = Object.freeze([]);

interface AgentEntry {
  state?: AppAgentState;
  usage?: AppAgentUsage;
  todos?: readonly AppTodoItem[];
}

export const useAgentStatesStore = defineStore('kimi.agentStates', () => {
  const bySession = ref<Record<string, Record<string, AgentEntry>>>({});

  function entryFor(sessionId: string, agentId: string): AgentEntry {
    const agents = (bySession.value[sessionId] ??= {});
    return (agents[agentId] ??= {});
  }

  function stateOf(sessionId: string, agentId: string): AppAgentState | undefined {
    return bySession.value[sessionId]?.[agentId]?.state;
  }

  function running(sessionId: string, agentId: string): boolean {
    return stateOf(sessionId, agentId)?.status === 'running';
  }

  function usageOf(sessionId: string, agentId: string): AppAgentUsage | undefined {
    return bySession.value[sessionId]?.[agentId]?.usage;
  }

  function todosOf(sessionId: string, agentId: string): readonly AppTodoItem[] {
    return bySession.value[sessionId]?.[agentId]?.todos ?? NO_TODOS;
  }

  function setState(sessionId: string, agentId: string, state: AppAgentState): void {
    entryFor(sessionId, agentId).state = state;
  }

  function setUsage(sessionId: string, agentId: string, usage: AppAgentUsage): void {
    entryFor(sessionId, agentId).usage = usage;
  }

  function setTodos(sessionId: string, agentId: string, todos: readonly AppTodoItem[]): void {
    entryFor(sessionId, agentId).todos = todos;
  }

  function forgetSession(sessionId: string): void {
    if (bySession.value[sessionId] === undefined) return;
    const { [sessionId]: _removed, ...rest } = bySession.value;
    void _removed;
    bySession.value = rest;
  }

  function forgetAgent(sessionId: string, agentId: string): void {
    const agents = bySession.value[sessionId];
    if (agents?.[agentId] === undefined) return;
    const { [agentId]: _removed, ...rest } = agents;
    void _removed;
    bySession.value = { ...bySession.value, [sessionId]: rest };
  }

  function resetAgentStates(): void {
    bySession.value = {};
  }

  return {
    bySession,
    stateOf,
    running,
    usageOf,
    todosOf,
    setState,
    setUsage,
    setTodos,
    forgetSession,
    forgetAgent,
    resetAgentStates,
  };
});

export function agentStatesStore() {
  return useAgentStatesStore(clientPinia);
}
