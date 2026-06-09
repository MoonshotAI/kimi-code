import { describe, expect, it } from "vitest";
import {
  AcpLegacyEventTranslator,
  type AcpPermissionRequest,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  type AcpTranslateOptions,
} from "../acp-legacy-events";
import type { StreamEvent } from "../schema";
import { acpLegacyFixtures } from "./fixtures/acp-legacy";

type SessionUpdateFixture = {
  name: string;
  method: "session/update";
  params: AcpSessionNotification;
  options?: AcpTranslateOptions;
  expectedEvents: StreamEvent[];
  suppressedOptions?: AcpTranslateOptions;
  expectedSuppressedEvents?: StreamEvent[];
  expectedUnknownSessionUpdate?: string;
};

type SessionUpdateSequenceFixture = {
  name: string;
  method: "session/update_sequence";
  params: {
    sessionId?: string;
    updates: AcpSessionNotification[];
  };
  expectedEvents: StreamEvent[];
};

type ExtensionNotificationFixture = {
  name: string;
  method: "kimi/step_interrupted" | "kimi/compaction" | "kimi/subagent_event";
  params: unknown;
  expectedEvents: StreamEvent[];
};

type PermissionRequestFixture = {
  name: string;
  method: "session/request_permission";
  id: string | number;
  params: AcpPermissionRequest;
  expectedEvent: StreamEvent;
};

type Fixture = SessionUpdateFixture | SessionUpdateSequenceFixture | ExtensionNotificationFixture | PermissionRequestFixture;

describe("AcpLegacyEventTranslator golden fixtures", () => {
  for (const fixture of acpLegacyFixtures as Fixture[]) {
    it(fixture.name, () => {
      if (fixture.method === "session/update") {
        const translator = new AcpLegacyEventTranslator();
        const unknownSessionUpdates: string[] = [];
        const events = translator.sessionUpdateToEvents(fixture.params, {
          ...fixture.options,
          onUnknownSessionUpdate: (update: AcpSessionUpdate) => {
            unknownSessionUpdates.push(update.sessionUpdate);
          },
        });

        expect(events).toEqual(fixture.expectedEvents);
        expect(unknownSessionUpdates).toEqual(fixture.expectedUnknownSessionUpdate ? [fixture.expectedUnknownSessionUpdate] : []);

        if (fixture.suppressedOptions) {
          expect(translator.sessionUpdateToEvents(fixture.params, fixture.suppressedOptions)).toEqual(fixture.expectedSuppressedEvents ?? []);
        }
        return;
      }

      if (fixture.method === "session/update_sequence") {
        const translator = new AcpLegacyEventTranslator();
        const events = fixture.params.updates.flatMap((notification) => translator.sessionUpdateToEvents(notification));
        expect(events).toEqual(fixture.expectedEvents);
        return;
      }

      if (fixture.method === "kimi/step_interrupted" || fixture.method === "kimi/compaction" || fixture.method === "kimi/subagent_event") {
        const translator = new AcpLegacyEventTranslator();
        expect(translator.extensionNotificationToEvents(fixture.method, fixture.params)).toEqual(fixture.expectedEvents);
        return;
      }

      const translator = new AcpLegacyEventTranslator();
      expect(translator.permissionRequestToEvent(fixture.id, fixture.params)).toEqual(fixture.expectedEvent);
    });
  }
});
