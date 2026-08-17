import { create } from "zustand";
import type { BackgroundTaskInfo } from "shared/legacy-sdk";
import { bridge } from "@/services";

interface TasksState {
  tasks: BackgroundTaskInfo[];
  browserOpen: boolean;
  setTasks: (tasks: BackgroundTaskInfo[]) => void;
  setBrowserOpen: (open: boolean) => void;
  refreshTasks: () => Promise<void>;
}

export const useTasksStore = create<TasksState>((set) => ({
  tasks: [],
  browserOpen: false,

  setTasks: (tasks) => {
    set({ tasks });
  },

  setBrowserOpen: (open) => {
    set({ browserOpen: open });
  },

  refreshTasks: async () => {
    const tasks = await bridge.listBackgroundTasks();
    set({ tasks });
  },
}));

/** Foreground tool calls (`detached === false`) are not user-facing background tasks. */
export function visibleBackgroundTasks(tasks: BackgroundTaskInfo[]): BackgroundTaskInfo[] {
  return tasks.filter((task) => task.detached !== false);
}

export function runningTaskCount(tasks: BackgroundTaskInfo[]): number {
  return tasks.filter((task) => task.status === "running").length;
}
