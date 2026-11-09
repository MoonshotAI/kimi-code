import { describe, expect, it } from "vitest";

import {
  BackgroundSessionNotificationTracker,
  getBackgroundSessionNotice,
} from "../src/session-notifications";

describe("background session notifications", () => {
  it("notifies when a background session finishes", () => {
    expect(getBackgroundSessionNotice({
      type: "stream_complete",
      result: { status: "finished" },
      _sessionId: "background",
    }, "active")).toEqual({ sessionId: "background", kind: "info", message: "finished" });
  });

  it("notifies when a background session needs input or fails", () => {
    expect(getBackgroundSessionNotice({
      type: "QuestionRequest",
      payload: {},
      _sessionId: "background",
    }, "active")?.message).toBe("needs your answer");
    expect(getBackgroundSessionNotice({
      type: "error",
      message: "Provider failed",
      _sessionId: "background",
    }, "active")).toEqual({ sessionId: "background", kind: "error", message: "failed" });
  });

  it("does not notify for the active session, cancellation, or mid-turn warnings", () => {
    expect(getBackgroundSessionNotice({
      type: "stream_complete",
      result: { status: "finished" },
      _sessionId: "active",
    }, "active")).toBeNull();
    expect(getBackgroundSessionNotice({
      type: "stream_complete",
      result: { status: "cancelled" },
      _sessionId: "background",
    }, "active")).toBeNull();
    expect(getBackgroundSessionNotice({
      type: "error",
      terminal: false,
      _sessionId: "background",
    }, "active")).toBeNull();
  });

  it("handles each host event exactly once", () => {
    const tracker = new BackgroundSessionNotificationTracker();
    const event = {
      type: "QuestionRequest",
      payload: {},
      _sessionId: "background",
    };

    expect(tracker.next(event, undefined)?.sessionId).toBe("background");
    expect(tracker.next(event, undefined)).toBeNull();
  });
});
