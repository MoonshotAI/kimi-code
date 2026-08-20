import { create } from "zustand";
import type { BackgroundTaskInfo } from "shared/legacy-sdk";
import type { BackgroundTasksChangedPayload } from "shared/types";
import { bridge } from "@/services";

interface TasksState {
  sessionId: string | null;
  tasks: BackgroundTaskInfo[];
  browserOpen: boolean;
  updateVersion: number;
  setSession: (sessionId: string | null) => void;
  applySnapshot: (payload: BackgroundTasksChangedPayload) => void;
  setBrowserOpen: (open: boolean) => void;
  refreshTasks: () => Promise<void>;
}

export const useTasksStore = create<TasksState>((set, get) => ({
  sessionId: null,
  tasks: [],
  browserOpen: false,
  updateVersion: 0,

  setSession: (sessionId) => {
    set((state) => {
      if (state.sessionId === sessionId) return state;
      return { sessionId, tasks: [], updateVersion: state.updateVersion + 1 };
    });
  },

  applySnapshot: (payload) => {
    set((state) => {
      if (state.sessionId !== payload.sessionId) return state;
      return { tasks: payload.tasks, updateVersion: state.updateVersion + 1 };
    });
  },

  setBrowserOpen: (open) => {
    set({ browserOpen: open });
  },

  refreshTasks: async () => {
    const { sessionId, updateVersion } = get();
    if (sessionId === null) return;
    const snapshot = await bridge.listBackgroundTasks();
    set((state) => {
      if (
        state.sessionId !== sessionId
        || snapshot.sessionId !== sessionId
        || state.updateVersion !== updateVersion
      ) return state;
      return { tasks: snapshot.tasks, updateVersion: state.updateVersion + 1 };
    });
  },
}));

/** Foreground tool calls (`detached === false`) are not user-facing background tasks. */
export function visibleBackgroundTasks(tasks: BackgroundTaskInfo[]): BackgroundTaskInfo[] {
  return tasks.filter((task) => task.detached !== false);
}

export function runningTaskCount(tasks: BackgroundTaskInfo[]): number {
  return tasks.filter((task) => task.status === "running").length;
}
