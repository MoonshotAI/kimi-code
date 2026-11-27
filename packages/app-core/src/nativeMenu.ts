export type NativeMenuItem =
  | { kind: 'separator' }
  | { kind: 'section'; id: string; label: string }
  | { kind: 'note'; id: string; label: string; size?: 'xs' }
  | { kind: 'choices'; icon?: string; id: string; label: string; value: string; options: { id: string; label: string }[] }
  | {
      kind: 'zoom';
      id: string;
      label: string;
      icon?: string;
      value: string;
      decreaseAction: string;
      decreaseLabel: string;
      increaseAction: string;
      increaseLabel: string;
      resetAction: string;
      resetLabel: string;
      decreaseDisabled?: boolean;
      increaseDisabled?: boolean;
      resetDisabled?: boolean;
    }
  | {
      kind: 'item';
      favicon?: string;
      id: string;
      label: string;
      icon?: string;
      description?: string;
      detail?: string;
      tone?: 'warning' | 'danger';
      starred?: boolean;
      shortcut?: string[];
      disabled?: boolean;
      selected?: boolean;
      danger?: boolean;
      keepOpen?: boolean;
    };
