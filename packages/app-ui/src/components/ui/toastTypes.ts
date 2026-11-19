import type { Component } from 'vue';
import type { AppNoticeCopyLink, AppNoticeDetail, AppNoticePosition } from '@moonshot-ai/app-core/api';

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';
export type ToastPosition = AppNoticePosition;

export interface ToastAction {
  label: string;
  onClick: (ctx: { dismiss: () => void }) => void | Promise<void>;
}

export interface ToastOptions {
  layout?: 'card' | 'bar';
  variant?: ToastVariant;
  title?: string;
  message?: string;
  details?: AppNoticeDetail[];
  copyLink?: AppNoticeCopyLink;
  actions?: ToastAction[];
  body?: Component;
  duration?: number;
  position?: ToastPosition;
  mode?: 'stack' | 'replace';
  running?: boolean;
  dismissLabel?: string;
}
