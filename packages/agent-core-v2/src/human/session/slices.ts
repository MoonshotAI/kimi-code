import { createSlice } from '#/eventStore/slice';

import type { AgentClosed, AgentOpened, AgentSwitched, SessionMetaUpdated } from './events';

export interface RosterState {
  agents: Record<string, string>;
}

export const rosterSlice = createSlice({
  name: 'roster',
  initialState: (): RosterState => ({ agents: {} }),
  reducers: {
    'agent.opened': (draft, event: AgentOpened) => {
      draft.agents[event.agentId] = event.branch;
    },
    'agent.closed': (draft, event: AgentClosed) => {
      delete draft.agents[event.agentId];
    },
    'agent.switched': (draft, event: AgentSwitched) => {
      draft.agents[event.agentId] = event.branch;
    },
  },
});

export interface SessionMetaState {
  value: unknown;
}

export const sessionMetaSlice = createSlice({
  name: 'sessionMeta',
  initialState: (): SessionMetaState => ({ value: undefined }),
  reducers: {
    'session.meta_updated': (draft, event: SessionMetaUpdated) => {
      draft.value = event.meta;
    },
  },
});

export const sessionSlices = { roster: rosterSlice, sessionMeta: sessionMetaSlice };
