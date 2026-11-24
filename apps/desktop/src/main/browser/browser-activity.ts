import type { BrowserOperation } from '../../shared/browser-automation';
import type { BrowserControlActivityKind } from '../../shared/browser-control';

export interface BrowserActivity {
  activity: BrowserControlActivityKind;
  scan: boolean;
}

const activities: Partial<Record<BrowserOperation, BrowserControlActivityKind>> = {
  'browser.create_tab': 'navigating',
  'tab.navigate': 'navigating',
  'tab.search': 'navigating',
  'tab.go_back': 'navigating',
  'tab.go_forward': 'navigating',
  'tab.reload': 'navigating',
  'tab.wait_for_load': 'waiting',
  'page.wait_for': 'waiting',
  'page.text.snapshot': 'reading',
  'page.elements.snapshot': 'inspecting',
  'page.visual.snapshot': 'capturing',
  'page.visual.crop': 'capturing',
  'page.visual.click': 'clicking',
  'page.visual.click_if_interactive': 'clicking',
  'page.visual.hover': 'hovering',
  'page.visual.scroll': 'scrolling',
  'page.visual.drag': 'dragging',
  'page.visual.drag_path': 'dragging',
  'page.visual.type_text': 'typing',
  'page.visual.press_key': 'pressing',
  'page.element.click': 'clicking',
  'page.element.hover': 'hovering',
  'page.element.fill': 'typing',
  'page.element.type_text': 'typing',
  'page.element.press_key': 'pressing',
  'page.element.select_option': 'selecting',
  'page.element.set_checked': 'checking',
  'page.element.scroll_into_view': 'scrolling',
  'page.dialog.get': 'answering',
  'page.dialog.respond': 'answering',
};

export function browserActivityFor(operation: BrowserOperation): BrowserActivity | undefined {
  const activity = activities[operation];
  return activity === undefined ? undefined : { activity, scan: activity === 'reading' || activity === 'inspecting' };
}

const passiveActivities = new Set<BrowserControlActivityKind>(['waiting', 'reading', 'inspecting', 'capturing']);

const silentActions = new Set<BrowserOperation>(['tab.set_device_mode', 'tab.stop_loading', 'browser.close_tab']);

export function browserOperationActs(operation: BrowserOperation): boolean {
  if (silentActions.has(operation)) return true;
  const activity = activities[operation];
  return activity !== undefined && !passiveActivities.has(activity) && operation !== 'page.dialog.get';
}
