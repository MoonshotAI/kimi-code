// @vitest-environment jsdom
import { createApp, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useToastTimer, type ToastTimer } from '../src/components/ui/useToastTimer';

let app: App | null = null;

function createTimer(duration: number, onExpire: () => void): ToastTimer {
  let timer!: ToastTimer;
  app = createApp({
    setup() {
      timer = useToastTimer({ duration: () => duration, onExpire });
      return () => null;
    },
  });
  app.mount(document.createElement('div'));
  return timer;
}

afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
});

describe('useToastTimer', () => {
  it('expires after the duration', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    createTimer(1000, onExpire);
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes with the remaining time', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timer = createTimer(1000, onExpire);
    vi.advanceTimersByTime(400);
    timer.pause();
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.resume();
    vi.advanceTimersByTime(599);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('never expires when the duration is zero', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timer = createTimer(0, onExpire);
    timer.resume();
    vi.advanceTimersByTime(60000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('gives an updated receipt its full duration and still pauses on hover', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timer = createTimer(6000, onExpire);
    vi.advanceTimersByTime(5900);
    timer.restart();
    timer.pause();
    vi.advanceTimersByTime(6000);
    timer.resume();
    vi.advanceTimersByTime(5999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('expires immediately when resumed after the deadline', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timer = createTimer(1000, onExpire);
    vi.advanceTimersByTime(400);
    vi.setSystemTime(1500);
    timer.pause();
    timer.resume();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('does not expire after dispose', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timer = createTimer(1000, onExpire);
    timer.dispose();
    vi.advanceTimersByTime(2000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
