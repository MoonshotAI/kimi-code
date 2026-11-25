import { inject, type InjectionKey, type Ref } from 'vue';
import type { NativeMenuItem } from '@moonshot-ai/app-core/native-menu';
import type { QuickModelMenuAction, QuickModelMenuPayload } from '@moonshot-ai/app-core/quick-model-menu';

export interface ComposerNativeMenu {
  available: boolean;
  open: Readonly<Ref<boolean>>;
  toggle(trigger: HTMLElement, options?: { initialFocus?: 'first-item' }): void;
  close(): void;
  refresh(): void;
}

export interface ComposerNativeMenuHost {
  register(options: {
    id: string;
    items(): NativeMenuItem[];
    modelMenu?(): QuickModelMenuPayload;
    footerStart?(): number;
    width: number;
    maxHeight?: number;
    autoWidth?: boolean;
    placement: 'top-start' | 'top-end';
    submitOnCtrlEnter?: boolean;
    onSelect(id: string): void;
    onModelAction?(action: QuickModelMenuAction): void;
    onDismiss?(): void;
  }): ComposerNativeMenu;
}

export const ComposerNativeMenuHostKey: InjectionKey<ComposerNativeMenuHost> = Symbol('composer-native-menu-host');
export const useComposerNativeMenuHost = (): ComposerNativeMenuHost | null => inject(ComposerNativeMenuHostKey, null);
