import { describe, expect, it, vi } from 'vitest';

import { findInput, fireTrigger, setInputValue, type RiveLike } from '@moonshot-ai/app-core/lib';

function fakeRive(inputsByMachine: Record<string, { name: string; value?: unknown; fire?: () => void }[]>): RiveLike {
  return {
    stateMachineNames: Object.keys(inputsByMachine),
    stateMachineInputs: (sm) => inputsByMachine[sm],
  };
}

describe('findInput', () => {
  it('returns the first input with the name across state machines', () => {
    const rive = fakeRive({
      idle: [{ name: 'light/dark', value: 0 }],
      other: [{ name: 'light/dark', value: 1 }],
    });
    expect(findInput(rive, 'light/dark')).toEqual({ name: 'light/dark', value: 0 });
  });

  it('skips machines without inputs and returns null when absent', () => {
    const rive = fakeRive({ idle: [] });
    expect(findInput(rive, 'nope')).toBeNull();
    expect(findInput({ stateMachineNames: [], stateMachineInputs: () => undefined }, 'x')).toBeNull();
  });
});

describe('fireTrigger', () => {
  it('fires a trigger input and reports success', () => {
    const fire = vi.fn();
    const rive = fakeRive({ idle: [{ name: 'click_avator', fire }] });
    expect(fireTrigger(rive, 'click_avator')).toBe(true);
    expect(fire).toHaveBeenCalledOnce();
  });

  it('returns false for missing or non-trigger inputs', () => {
    const rive = fakeRive({ idle: [{ name: 'click_avator', value: 0 }] });
    expect(fireTrigger(rive, 'click_avator')).toBe(false);
    expect(fireTrigger(rive, 'absent')).toBe(false);
  });
});

describe('setInputValue', () => {
  it('sets a number input when the existing value is a number', () => {
    const input = { name: 'light/dark', value: 0 };
    const rive = fakeRive({ idle: [input] });
    expect(setInputValue(rive, 'light/dark', 1)).toBe(true);
    expect(input.value).toBe(1);
  });

  it('sets a boolean input when the existing value is a boolean', () => {
    const input = { name: 'hoverspace', value: false };
    const rive = fakeRive({ idle: [input] });
    expect(setInputValue(rive, 'hoverspace', true)).toBe(true);
    expect(input.value).toBe(true);
  });

  it('refuses type mismatches and missing inputs', () => {
    const num = { name: 'light/dark', value: 0 };
    const bool = { name: 'hoverspace', value: false };
    const rive = fakeRive({ idle: [num, bool] });
    expect(setInputValue(rive, 'light/dark', true)).toBe(false);
    expect(setInputValue(rive, 'hoverspace', 1)).toBe(false);
    expect(setInputValue(rive, 'absent', 1)).toBe(false);
    expect(num.value).toBe(0);
    expect(bool.value).toBe(false);
  });
});
