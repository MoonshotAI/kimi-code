import { Script, createContext } from 'node:vm';
import { expect, it } from 'vitest';
import { visualTargetProbeCode } from '../../../src/main/browser/browser-page';
import type { BrowserClickFeedback } from '../../../src/shared/browser-automation';

class Node {
  children: Node[] = [];
  parentElement: Node | null = null;
  isConnected = true;
  classList = ['control'];
  id = '';
  disabled = false;
  pointer = false;
  shadowRoot: any;
  constructor(public tagName: string, public x: number, public y: number, public width = 20, public height = 20, public textContent = 'Target') {}
  getRootNode(): any { return {}; }
  matches(selector: string) {
    if (selector.startsWith(':disabled')) return this.disabled;
    if (selector.startsWith('button,a')) return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(this.tagName);
    return false;
  }
  hasAttribute() { return false; }
  getAttribute() { return null; }
  getBoundingClientRect() { return { x: this.x, y: this.y, left: this.x, top: this.y, right: this.x + this.width, bottom: this.y + this.height, width: this.width, height: this.height }; }
}

function scene(nodes: Node[]) {
  const world = {
    document: {
      querySelectorAll: () => nodes,
      elementFromPoint: (x: number, y: number) => [...nodes].reverse().find(node => node.x <= x && node.y <= y && x < node.x + node.width && y < node.y + node.height) ?? null,
    },
    getComputedStyle: (node: Node) => ({ cursor: node.pointer ? 'pointer' : 'default', display: 'block', visibility: 'visible', opacity: '1' }),
    innerWidth: 500, innerHeight: 500,
  };
  const context = createContext(world);
  return {
    probe: (x: number, y: number, radius = 48, scale = { x: 1, y: 1 }): BrowserClickFeedback => new Script(visualTargetProbeCode('elements-test', { x, y }, radius, scale)).runInContext(context),
    guard: (x: number, y: number, ref: string): boolean => new Script(visualTargetProbeCode('elements-test', { x, y }, 48, { x: 1, y: 1 }, ref)).runInContext(context),
  };
}

it('recognizes the button owning a hit child and returns image-pixel bounds', () => {
  const button = new Node('BUTTON', 50, 40, 40, 40, 'Save');
  const child = new Node('SPAN', 60, 50, 10, 10, 'Save'); child.parentElement = button; child.pointer = true; button.children = [child];
  const world = scene([button, child]);
  const result = world.probe(65, 55, 48, { x: 2, y: 2 });
  expect(result.target).toMatchObject({ tagName: 'button', name: 'Save', clickable: true, evidence: 'native', ref: 'e1', bounds: { x: 100, y: 80, width: 80, height: 80 } });
  expect(world.guard(65, 55, 'e1')).toBe(true);
  button.isConnected = false;
  expect(world.guard(65, 55, 'e1')).toBe(false);
});

it('reports nearby controls without choosing one for an empty point', () => {
  const world = scene([new Node('BUTTON', 70, 40)]);
  const result = world.probe(50, 50);
  expect(result.target).toBeUndefined();
  expect(result.outcome).toBe('no_target');
  expect(result.nearby).toMatchObject([{ ref: 'e1', clickable: true }]);
  expect(result.needsVisualConfirmation).toBe(false);
});

it.each(['CANVAS', 'IFRAME', 'EMBED', 'OBJECT'])('requires visual confirmation for %s even with pointer styling', tag => {
  const canvas = new Node(tag, 0, 0, 100, 100, ''); canvas.pointer = true;
  const result = scene([canvas]).probe(50, 50);
  expect(result.target).toBeUndefined();
  expect(result.needsVisualConfirmation).toBe(true);
  expect(result.nearby).toMatchObject([{ tagName: tag.toLowerCase(), clickable: false, evidence: 'none' }]);
});

it('does not select a disabled or obscured button', () => {
  const button = new Node('BUTTON', 40, 40); button.disabled = true;
  expect(scene([button]).probe(50, 50).target).toBeUndefined();
  button.disabled = false;
  const mask = new Node('DIV', 0, 0, 100, 100, 'Overlay');
  const result = scene([button, mask]).probe(50, 50);
  expect(result.target).toBeUndefined();
  expect(result.nearby.some(item => item.clickable)).toBe(false);
});

it('rechecks hit testing and disabled state before clicking', () => {
  const button = new Node('BUTTON', 40, 40);
  const nodes = [button]; const world = scene(nodes);
  const ref = world.probe(50, 50).target!.ref!;
  button.disabled = true;
  expect(world.guard(50, 50, ref)).toBe(false);
  button.disabled = false;
  nodes.push(new Node('DIV', 40, 40));
  expect(world.guard(50, 50, ref)).toBe(false);
});

it('finds controls in an open shadow root', () => {
  const host = new Node('DIV', 40, 40, 40, 40);
  const button = new Node('BUTTON', 40, 40, 40, 40);
  host.shadowRoot = { host, querySelectorAll: () => [button], elementFromPoint: () => button };
  button.getRootNode = () => host.shadowRoot;
  expect(scene([host]).probe(50, 50).target?.tagName).toBe('button');
});

it('bounds candidate output and explicitly reports truncation', () => {
  const buttons = Array.from({ length: 30 }, (_, index) => new Node('BUTTON', 20 + index * 3, 40, 2, 2));
  const result = scene(buttons).probe(50, 50, 128);
  expect(result.nearby).toHaveLength(24);
  expect(result.truncated).toBe(true);
});
