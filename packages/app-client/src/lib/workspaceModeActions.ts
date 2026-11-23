import { goalStore } from '../stores/goal';
import { modeStore } from '../stores/mode';

export function workspaceModeActions(
  sendTowerPrompt: (text: string, editText?: string) => Promise<void>,
) {
  return {
    setPlanMode: modeStore().setPlanMode,
    togglePlanMode: modeStore().togglePlanMode,
    setSwarmMode: modeStore().setSwarmMode,
    toggleSwarmMode: modeStore().toggleSwarmMode,
    setTowerMode: modeStore().setTowerMode,
    toggleTowerMode: modeStore().toggleTowerMode,
    sendTowerPrompt,
    setGoalMode: modeStore().setGoalMode,
    toggleGoalMode: modeStore().toggleGoalMode,
    createGoal: goalStore().createGoal,
    controlGoal: goalStore().controlGoal,
    editGoalObjective: goalStore().editGoalObjective,
  };
}
