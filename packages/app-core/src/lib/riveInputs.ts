
export interface RiveInputLike {
  name: string;
  value?: unknown;
  fire?: () => void;
}

export interface RiveLike {
  stateMachineNames: string[];
  stateMachineInputs: (stateMachine: string) => RiveInputLike[] | undefined;
}

export function findInput(rive: RiveLike, name: string): RiveInputLike | null {
  for (const stateMachine of rive.stateMachineNames) {
    const input = (rive.stateMachineInputs(stateMachine) ?? []).find((i) => i.name === name);
    if (input !== undefined) return input;
  }
  return null;
}

export function fireTrigger(rive: RiveLike, name: string): boolean {
  const input = findInput(rive, name);
  if (input !== null && typeof input.fire === 'function') {
    input.fire();
    return true;
  }
  return false;
}

export function setInputValue(rive: RiveLike, name: string, value: boolean | number): boolean {
  const input = findInput(rive, name);
  if (input !== null && typeof input.value === typeof value) {
    input.value = value;
    return true;
  }
  return false;
}
