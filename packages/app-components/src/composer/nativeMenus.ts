import { inject, type InjectionKey, type Ref } from 'vue';
import type { NativeMenuItem } from '@moonshot-ai/app-core/native-menu';

export type NativeMenuPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface NativeMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeMenuShowOptions {
  placement?: NativeMenuPlacement;
  offset?: number;
  initialFocus?: 'none' | 'first-item';
}

export interface ComposerNativeMenu {
  available: boolean;
  open: Readonly<Ref<boolean>>;
  showAt(anchor: NativeMenuAnchor, options?: NativeMenuShowOptions & { focusReturn?: HTMLElement }): void;
  toggle(trigger: HTMLElement, options?: NativeMenuShowOptions): void;
  close(options?: { refocus?: boolean }): void;
  refresh(): void;
}

export interface NativeMenuHost {
  register(options: {
    id: string;
    items(): NativeMenuItem[];
    footerStart?(): number;
    width?: number;
    autoWidth?: boolean;
    placement?: NativeMenuPlacement;
    offset?: number;
    submitOnCtrlEnter?: boolean;
    onSelect(id: string): void;
    onClose?(payload: { menuId: string; reason: string }): void;
    onDismiss?(): void;
  }): ComposerNativeMenu;
}

export type ComposerNativeMenuHost = NativeMenuHost;

export const NativeMenuHostKey: InjectionKey<NativeMenuHost> = Symbol('native-menu-host');
export const ComposerNativeMenuHostKey: InjectionKey<ComposerNativeMenuHost> = NativeMenuHostKey;
export const useNativeMenuHost = (): NativeMenuHost | null => inject(NativeMenuHostKey, null);
export const useComposerNativeMenuHost = (): ComposerNativeMenuHost | null => inject(ComposerNativeMenuHostKey, null);
