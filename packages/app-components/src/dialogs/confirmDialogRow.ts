export type ConfirmDialogRowTone = 'muted' | 'warning' | 'danger' | 'success';

export interface ConfirmDialogRow {
  key?: string;
  icon: string;
  text: string;
  tone?: ConfirmDialogRowTone;
  trailing?: string;
  spinning?: boolean;
}

export type ConfirmDialogCancelSource = 'button' | 'dismiss';
