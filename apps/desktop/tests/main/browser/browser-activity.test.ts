import { expect, it } from 'vitest';
import { browserActivityFor, browserOperationActs } from '../../../src/main/browser/browser-activity';
import { BROWSER_OPERATIONS } from '../../../src/shared/browser-automation';

it('describes what the agent is doing for every operation that touches a page', () => {
  expect(browserActivityFor('page.text.snapshot')).toEqual({ activity: 'reading', scan: true });
  expect(browserActivityFor('page.elements.snapshot')).toEqual({ activity: 'inspecting', scan: true });
  expect(browserActivityFor('page.visual.snapshot')).toEqual({ activity: 'capturing', scan: false });
  expect(browserActivityFor('page.element.click')).toEqual({ activity: 'clicking', scan: false });
  expect(browserActivityFor('page.visual.click_if_interactive')).toEqual({ activity: 'clicking', scan: false });
  expect(browserActivityFor('page.element.fill')).toEqual({ activity: 'typing', scan: false });
  expect(browserActivityFor('page.element.press_key')).toEqual({ activity: 'pressing', scan: false });
  expect(browserActivityFor('page.element.select_option')).toEqual({ activity: 'selecting', scan: false });
  expect(browserActivityFor('page.element.set_checked')).toEqual({ activity: 'checking', scan: false });
  expect(browserActivityFor('page.visual.drag')).toEqual({ activity: 'dragging', scan: false });
  expect(browserActivityFor('tab.go_back')).toEqual({ activity: 'navigating', scan: false });
  expect(browserActivityFor('page.wait_for')).toEqual({ activity: 'waiting', scan: false });
  expect(browserActivityFor('page.dialog.respond')).toEqual({ activity: 'answering', scan: false });
});

it('stays silent for bookkeeping operations and covers every page operation', () => {
  for (const operation of ['browser.get_state', 'browser.get_history', 'browser.activate_tab', 'tab.get_state', 'tab.set_device_mode'] as const) {
    expect(browserActivityFor(operation)).toBeUndefined();
  }
  for (const operation of BROWSER_OPERATIONS.filter(name => name.startsWith('page.'))) {
    expect(browserActivityFor(operation), operation).toBeDefined();
  }
});

it('counts only operations that can act on the page as agent actions', () => {
  for (const operation of ['page.element.click', 'page.visual.type_text', 'tab.navigate', 'page.dialog.respond'] as const) expect(browserOperationActs(operation)).toBe(true);
  for (const operation of ['tab.set_device_mode', 'tab.stop_loading', 'browser.close_tab'] as const) expect(browserOperationActs(operation), operation).toBe(true);
  for (const operation of ['page.text.snapshot', 'page.elements.snapshot', 'page.visual.snapshot', 'tab.wait_for_load', 'page.dialog.get', 'browser.get_state'] as const) expect(browserOperationActs(operation)).toBe(false);
});
