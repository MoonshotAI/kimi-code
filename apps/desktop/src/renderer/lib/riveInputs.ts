// Structural helpers for poking a Rive instance's state-machine inputs by
// name. The mascot component (components/KimiMascot.vue) drives the official
// mascot asset defensively: input names are what the strings in the .riv
// suggest, and anything the asset doesn't actually expose must no-op instead
// of throwing. Kept framework-free and structural (no @rive-app imports) so
// it's unit-testable without the wasm runtime.

export interface RiveInputLike {
  name: string;
  value?: unknown;
  fire?: () => void;
}

export interface RiveLike {
  stateMachineNames: string[];
  stateMachineInputs: (stateMachine: string) => RiveInputLike[] | undefined;
}

/** First input with this name across all state machines, or null. */
export function findInput(rive: RiveLike, name: string): RiveInputLike | null {
  for (const stateMachine of rive.stateMachineNames) {
    const input = (rive.stateMachineInputs(stateMachine) ?? []).find((i) => i.name === name);
    if (input !== undefined) return input;
  }
  return null;
}

/** Fire a named trigger. Returns false when the asset has no such trigger. */
export function fireTrigger(rive: RiveLike, name: string): boolean {
  const input = findInput(rive, name);
  if (input !== null && typeof input.fire === 'function') {
    input.fire();
    return true;
  }
  return false;
}

/** Set a named boolean/number input, but only when the existing value has the
    same primitive type (never smuggle a number into a boolean input). Returns
    false when the asset has no such input. */
export function setInputValue(rive: RiveLike, name: string, value: boolean | number): boolean {
  const input = findInput(rive, name);
  if (input !== null && typeof input.value === typeof value) {
    input.value = value;
    return true;
  }
  return false;
}
