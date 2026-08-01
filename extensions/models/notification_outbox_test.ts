// MIT License
//
// Copyright (c) 2026 Mat Greten
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  classifyTransportError,
  drainNotificationsFold,
  model,
  notificationDedupKey,
  NotificationSchema,
  notificationToEnqueue,
  type OutboxMethodContext,
  redactNotificationPayload,
} from "./notification_outbox.ts";

const ERA_A = "2026-07-18T00:00:00.000Z";
const ERA_B = "2026-07-18T06:00:00.000Z";

type WrittenResource = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
  tags?: Record<string, string>;
};

/**
 * A minimal in-memory method context: it captures every writeResource call so
 * a test can assert what the method persisted. No transport or external I/O.
 */
function testContext(): {
  context: OutboxMethodContext;
  getWrittenResources: () => WrittenResource[];
  setLatestResource: (name: string, data: unknown) => void;
  setLatestRawContent: (name: string, data: Uint8Array) => void;
} {
  const written: WrittenResource[] = [];
  const latest = new Map<string, unknown>();
  const rawContent = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const context: OutboxMethodContext = {
    modelType: "@mgreten/notification-outbox",
    modelId: "test-outbox",
    globalArgs: {},
    dataRepository: {
      getContent: (_modelType, _modelId, name) => {
        const raw = rawContent.get(name);
        if (raw !== undefined) return Promise.resolve(raw);
        const resource = latest.get(name);
        return Promise.resolve(
          resource === undefined
            ? null
            : encoder.encode(JSON.stringify(resource)),
        );
      },
    },
    logger: {
      info: () => {},
      warning: () => {},
      error: () => {},
    },
    writeResource: (specName, name, data, overrides) => {
      const record: WrittenResource = {
        specName,
        name,
        data,
        tags: overrides?.tags,
      };
      written.push(record);
      latest.set(name, data);
      // deno-lint-ignore no-explicit-any
      return Promise.resolve(record as any);
    },
  };
  return {
    context,
    getWrittenResources: () => written,
    setLatestResource: (name, data) => {
      rawContent.delete(name);
      latest.set(name, data);
    },
    setLatestRawContent: (name, data) => {
      latest.delete(name);
      rawContent.set(name, data);
    },
  };
}

Deno.test("redactNotificationPayload strips secrets by key, secret-shaped values, and absolute paths", () => {
  const redacted = redactNotificationPayload({
    prUrl: "https://github.com/acme/app/pull/42",
    token: "should-be-masked-regardless",
    apiKey: "abc",
    branch: "feature-WI-800",
    worktreePath: "/home/user/git/app-WI-800",
    ghToken: "ghp_0123456789abcdefABCDEF0123456789abcd",
    nested: {
      Authorization: "Bearer sk-secretvalue",
      note: "all clear",
      creds: "https://user:pass@host/x",
    },
    steps: ["/absolute/host/path/file", "a normal step"],
  }) as Record<string, unknown>;

  // Key-based redaction (token/apiKey/Authorization/creds) always masks.
  assertEquals(redacted.token, "[REDACTED]");
  assertEquals(redacted.apiKey, "[REDACTED]");
  const nested = redacted.nested as Record<string, unknown>;
  assertEquals(nested.Authorization, "[REDACTED]");
  assertEquals(nested.creds, "[REDACTED]");
  assertEquals(nested.note, "all clear");
  // Value-shape redaction: a token-shaped value and an absolute path are masked.
  assertEquals(redacted.ghToken, "[REDACTED]");
  assertEquals(redacted.worktreePath, "[REDACTED]");
  assertEquals((redacted.steps as unknown[])[0], "[REDACTED]");
  assertEquals((redacted.steps as unknown[])[1], "a normal step");
  // A normal PR URL and branch survive — those are not secrets.
  assertEquals(redacted.prUrl, "https://github.com/acme/app/pull/42");
  assertEquals(redacted.branch, "feature-WI-800");
});

Deno.test("notificationDedupKey is stable per (workItem,event,era) and era-scoped", () => {
  const k1 = notificationDedupKey("WI-800", "failed", ERA_A);
  const k2 = notificationDedupKey("WI-800", "failed", ERA_A);
  const kOtherEra = notificationDedupKey("WI-800", "failed", ERA_B);
  const kOtherEvent = notificationDedupKey("WI-800", "completed", ERA_A);
  assertEquals(k1, k2);
  assert(k1 !== kOtherEra, "a different era must not dedup-collide");
  assert(k1 !== kOtherEvent, "a different event must not dedup-collide");
  assert(k1.startsWith("failed-"));
});

Deno.test("notificationToEnqueue redacts and builds a pending record when no prior exists", () => {
  const record = notificationToEnqueue(
    {
      workItem: "WI-800",
      event: "approval-needed",
      urgency: "high",
      era: ERA_A,
      payload: { token: "ghp_secret", gate: "submit-approval" },
    },
    ERA_A,
  );
  assert(record !== null);
  assert(NotificationSchema.safeParse(record).success);
  assertEquals(record!.status, "pending");
  assertEquals(record!.attempts, 0);
  assertEquals(record!.event, "approval-needed");
  assertEquals(record!.redactionVersion, "2");
  assertEquals(
    (record!.payload as Record<string, unknown>).token,
    "[REDACTED]",
  );
  assertEquals(
    (record!.payload as Record<string, unknown>).gate,
    "submit-approval",
  );
});

Deno.test("notificationToEnqueue dedups an identical pending/delivered event this era, but not across eras", () => {
  const base = notificationToEnqueue(
    {
      workItem: "WI-800",
      event: "failed",
      urgency: "default",
      era: ERA_A,
      payload: {},
    },
    ERA_A,
  )!;
  // Same era, existing pending -> dedup (null).
  const dup = notificationToEnqueue(
    {
      workItem: "WI-800",
      event: "failed",
      urgency: "default",
      era: ERA_A,
      payload: {},
      existing: base,
    },
    ERA_A,
  );
  assertEquals(dup, null);

  // Same era, existing DELIVERED -> still dedup.
  const delivered = NotificationSchema.parse({ ...base, status: "delivered" });
  const dupDelivered = notificationToEnqueue(
    {
      workItem: "WI-800",
      event: "failed",
      urgency: "default",
      era: ERA_A,
      payload: {},
      existing: delivered,
    },
    ERA_A,
  );
  assertEquals(dupDelivered, null);

  // A different era: the SAME event is NOT falsely deduped (a re-run re-notifies).
  const nextEra = notificationToEnqueue(
    {
      workItem: "WI-800",
      event: "failed",
      urgency: "default",
      era: ERA_B,
      payload: {},
      // The prior record was keyed to ERA_A, so its dedupKey differs.
      existing: base,
    },
    ERA_B,
  );
  assert(nextEra !== null, "a new era must not be deduped");
  assert(nextEra!.dedupKey !== base.dedupKey);

  // A prior FAILED record IS re-enqueueable (a failed delivery is not a
  // delivered one), so a later enqueue produces a fresh pending record.
  const failed = NotificationSchema.parse({
    ...base,
    status: "failed",
    attempts: 2,
  });
  const reEnqueued = notificationToEnqueue(
    {
      workItem: "WI-800",
      event: "failed",
      urgency: "default",
      era: ERA_A,
      payload: {},
      existing: failed,
    },
    ERA_A,
  );
  assert(reEnqueued !== null);
  assertEquals(reEnqueued!.status, "pending");
});

function pendingNotification(dedupKey = "failed-deadbeef") {
  return NotificationSchema.parse({
    workItem: "WI-800",
    event: "failed",
    urgency: "default",
    dedupKey,
    era: ERA_A,
    payload: {},
    status: "pending",
    attempts: 0,
    enqueuedAt: ERA_A,
    updatedAt: ERA_A,
    policyVersion: "1",
    redactionVersion: "1",
  });
}

Deno.test("classifyTransportError makes every supplied error non-data-bearing", () => {
  const rawErrors = [
    "connection refused",
    "request failed; bearer abc",
    "authentication failed",
    "transport token expired",
    "invalid API-key supplied",
    "password rejected",
    "cookie parse failure",
    "unable to load private-key",
    "upstream returned ghp_abc123",
    "Slack rejected xoxb-123",
    "provider rejected sk-live123",
    "JWT eyJhbGciOiJIUzI1NiJ9 rejected",
    "fetch https://user:pass@example.com/hook failed",
    "failed reading /home/mat/.config/service",
    String.raw`failed reading C:\Users\mat\secret.txt`,
    "opaque AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_- value",
    "line one\nline two",
    "x".repeat(201),
  ];

  for (const [index, rawError] of rawErrors.entries()) {
    assertEquals(
      classifyTransportError(rawError),
      "transport delivery failed",
      rawError,
    );
    const pending = pendingNotification(`failed-classify${index}`);
    const [drained] = drainNotificationsFold(
      [pending],
      [{ dedupKey: pending.dedupKey, delivered: false, error: rawError }],
      ERA_B,
    );
    assertEquals(drained.lastError, "transport delivery failed");
    assert(!JSON.stringify(drained).includes(rawError), rawError);
  }
});

Deno.test("drainNotificationsFold omits lastError when no raw error is supplied", () => {
  const pending = pendingNotification("failed-noerror11");
  const [drained] = drainNotificationsFold(
    [pending],
    [{ dedupKey: pending.dedupKey, delivered: false }],
    ERA_B,
  );
  assertEquals(drained.status, "failed");
  assertEquals(drained.lastError, undefined);
  assert(!Object.hasOwn(drained, "lastError"));
});

Deno.test("errorless retry of a legacy failed record removes inherited lastError", () => {
  const legacy = NotificationSchema.parse({
    ...pendingNotification("failed-legacyraw1"),
    status: "failed",
    attempts: 2,
    lastError: "RAW_SECRET_ERROR",
  });

  const [drained] = drainNotificationsFold(
    [legacy],
    [{ dedupKey: legacy.dedupKey, delivered: false }],
    ERA_B,
  );

  assertEquals(drained.status, "failed");
  assertEquals(drained.attempts, 3);
  assertEquals(drained.redactionVersion, "1");
  assert(!Object.hasOwn(drained, "lastError"));
  assert(!JSON.stringify(drained).includes("RAW_SECRET_ERROR"));
});

Deno.test("v1 records remain parseable and drain without upgrading their persisted version", () => {
  const legacy = pendingNotification("failed-legacy111");
  assertEquals(legacy.redactionVersion, "1");

  const [drained] = drainNotificationsFold(
    [legacy],
    [{
      dedupKey: legacy.dedupKey,
      delivered: false,
      error: "connection refused",
    }],
    ERA_B,
  );

  assertEquals(drained.status, "failed");
  assertEquals(drained.lastError, "transport delivery failed");
  assertEquals(drained.redactionVersion, "1");
  assert(NotificationSchema.safeParse(drained).success);
});

Deno.test("drainNotificationsFold marks delivered and failed, bumping attempts on failure only", () => {
  const a = pendingNotification("failed-aaaa1111");
  const b = pendingNotification("failed-bbbb2222");
  const updated = drainNotificationsFold(
    [a, b],
    [
      { dedupKey: "failed-aaaa1111", delivered: true },
      {
        dedupKey: "failed-bbbb2222",
        delivered: false,
        error: "connection refused",
      },
    ],
    ERA_B,
  );
  const byKey = new Map(updated.map((n) => [n.dedupKey, n]));
  assertEquals(byKey.get("failed-aaaa1111")!.status, "delivered");
  assertEquals(byKey.get("failed-aaaa1111")!.attempts, 0);
  assertEquals(byKey.get("failed-bbbb2222")!.status, "failed");
  assertEquals(byKey.get("failed-bbbb2222")!.attempts, 1);
  assertEquals(
    byKey.get("failed-bbbb2222")!.lastError,
    "transport delivery failed",
  );
});

Deno.test("drainNotificationsFold is idempotent: re-draining a delivered record is a no-op; a redelivery of a failed one bumps attempts again", () => {
  const delivered = NotificationSchema.parse({
    ...pendingNotification(),
    status: "delivered",
  });
  const noop = drainNotificationsFold(
    [delivered],
    [{
      dedupKey: delivered.dedupKey,
      delivered: false,
      error: "should be ignored",
    }],
    ERA_B,
  );
  // A delivered record is terminal for delivery — a later failed transport
  // result cannot flip it back.
  assertEquals(noop[0].status, "delivered");
  assertEquals(noop[0].attempts, 0);

  const failedOnce = NotificationSchema.parse({
    ...pendingNotification(),
    status: "failed",
    attempts: 1,
  });
  const retried = drainNotificationsFold(
    [failedOnce],
    [{ dedupKey: failedOnce.dedupKey, delivered: false, error: "again" }],
    ERA_B,
  );
  assertEquals(retried[0].status, "failed");
  assertEquals(retried[0].attempts, 2);

  // A record with no transport result is left untouched (nothing attempted).
  const untouched = drainNotificationsFold([pendingNotification()], [], ERA_B);
  assertEquals(untouched[0].status, "pending");
  assertEquals(untouched[0].attempts, 0);
});

Deno.test("enqueueNotification persists a redacted record and atomically dedups a retry without caller existing", async () => {
  const test = testContext();
  await model.methods.enqueueNotification.execute(
    {
      workItem: "WI-801",
      event: "completed",
      urgency: "default",
      era: ERA_A,
      payload: { prUrl: "https://github.com/acme/app/pull/7", token: "sk-xyz" },
    },
    test.context,
  );
  let written = test.getWrittenResources();
  assertEquals(written.length, 1);
  const record = written[0].data as unknown as z.infer<
    typeof NotificationSchema
  >;
  assertEquals(record.status, "pending");
  assertEquals((record.payload as Record<string, unknown>).token, "[REDACTED]");
  assertEquals(
    (record.payload as Record<string, unknown>).prUrl,
    "https://github.com/acme/app/pull/7",
  );
  const name = written[0].name;
  assertEquals(name, "notification-WI-801-completed");

  // The in-memory repository now exposes the authoritative latest resource. A
  // retry without caller-provided `existing` dedups and writes no new version.
  await model.methods.enqueueNotification.execute(
    {
      workItem: "WI-801",
      event: "completed",
      urgency: "default",
      era: ERA_A,
      payload: {},
    },
    test.context,
  );
  written = test.getWrittenResources();
  assertEquals(written.length, 1, "a dedup hit must write nothing");
});

Deno.test("persisted pending or delivered records win over stale or absent caller existing", async () => {
  for (const status of ["pending", "delivered"] as const) {
    const test = testContext();
    const name = "notification-WI-802-failed";
    const persisted = NotificationSchema.parse({
      ...pendingNotification(notificationDedupKey("WI-802", "failed", ERA_A)),
      workItem: "WI-802",
      status,
    });
    test.setLatestResource(name, persisted);

    const staleCaller = NotificationSchema.parse({
      ...persisted,
      status: "failed",
      era: ERA_B,
      dedupKey: notificationDedupKey("WI-802", "failed", ERA_B),
    });
    await model.methods.enqueueNotification.execute(
      {
        workItem: "WI-802",
        event: "failed",
        urgency: "default",
        era: ERA_A,
        payload: {},
        existing: status === "pending" ? staleCaller : undefined,
      },
      test.context,
    );

    assertEquals(
      test.getWrittenResources().length,
      0,
      `persisted ${status} must dedup regardless of caller existing`,
    );
  }
});

Deno.test("malformed persisted JSON fails safely without writing", async () => {
  const test = testContext();
  test.setLatestRawContent(
    "notification-WI-803-completed",
    new TextEncoder().encode('{"workItem":"secret-content"'),
  );

  const error = await assertRejects(
    () =>
      model.methods.enqueueNotification.execute(
        {
          workItem: "WI-803",
          event: "completed",
          urgency: "default",
          era: ERA_A,
          payload: {},
        },
        test.context,
      ),
    Error,
    "Persisted notification record is invalid",
  );
  assertEquals(error.message, "Persisted notification record is invalid");
  assertEquals(test.getWrittenResources().length, 0);
});

Deno.test("malformed persisted schema fails safely without writing", async () => {
  const test = testContext();
  test.setLatestResource("notification-WI-803-completed", {
    workItem: "WI-803",
    status: "pending",
  });

  const error = await assertRejects(
    () =>
      model.methods.enqueueNotification.execute(
        {
          workItem: "WI-803",
          event: "completed",
          urgency: "default",
          era: ERA_A,
          payload: {},
        },
        test.context,
      ),
    Error,
    "Persisted notification record is invalid",
  );
  assertEquals(error.message, "Persisted notification record is invalid");
  assertEquals(test.getWrittenResources().length, 0);
});

Deno.test("a failed persisted record can be atomically re-enqueued", async () => {
  const test = testContext();
  const name = "notification-WI-804-failed";
  test.setLatestResource(
    name,
    NotificationSchema.parse({
      ...pendingNotification(notificationDedupKey("WI-804", "failed", ERA_A)),
      workItem: "WI-804",
      status: "failed",
      attempts: 2,
    }),
  );

  await model.methods.enqueueNotification.execute(
    {
      workItem: "WI-804",
      event: "failed",
      urgency: "high",
      era: ERA_A,
      payload: { reason: "retry" },
    },
    test.context,
  );

  const written = test.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].name, name);
  const record = NotificationSchema.parse(written[0].data);
  assertEquals(record.status, "pending");
  assertEquals(record.attempts, 0);
  assertEquals(record.urgency, "high");
});

Deno.test("stale drain cannot overwrite a newer persisted era", async () => {
  const test = testContext();
  const oldRecord = pendingNotification(
    notificationDedupKey("WI-805", "failed", ERA_A),
  );
  const newerRecord = NotificationSchema.parse({
    ...oldRecord,
    dedupKey: notificationDedupKey("WI-805", "failed", ERA_B),
    era: ERA_B,
    attempts: 3,
    enqueuedAt: ERA_B,
    updatedAt: ERA_B,
  });
  const name = "notification-WI-805-failed";
  test.setLatestResource(name, newerRecord);

  const result = await model.methods.drainNotifications.execute(
    {
      notifications: [oldRecord],
      transportResults: [{ dedupKey: oldRecord.dedupKey, delivered: true }],
    },
    test.context,
  );

  assertEquals(result.dataHandles, []);
  assertEquals(test.getWrittenResources().length, 0);
  // The authoritative object remains exactly the newer era record.
  assertEquals(newerRecord.era, ERA_B);
  assertEquals(newerRecord.attempts, 3);
  assertEquals(newerRecord.status, "pending");
});

Deno.test("drain folds a same-key failure from authoritative current attempts", async () => {
  const test = testContext();
  const caller = pendingNotification("failed-current1");
  const current = NotificationSchema.parse({
    ...caller,
    status: "failed",
    attempts: 4,
    updatedAt: ERA_B,
  });
  test.setLatestResource("notification-WI-800-failed", current);

  const result = await model.methods.drainNotifications.execute(
    {
      notifications: [caller],
      transportResults: [{
        dedupKey: caller.dedupKey,
        delivered: false,
        error: "secret transport detail",
      }],
    },
    test.context,
  );

  assertEquals(result.dataHandles?.length, 1);
  const [write] = test.getWrittenResources();
  const updated = NotificationSchema.parse(write.data);
  assertEquals(updated.status, "failed");
  assertEquals(updated.attempts, 5);
  assertEquals(updated.lastError, "transport delivery failed");
});

Deno.test("malformed authoritative current fails drain safely without writing", async () => {
  const test = testContext();
  const caller = pendingNotification("failed-malformed1");
  test.setLatestRawContent(
    "notification-WI-800-failed",
    new TextEncoder().encode('{"dedupKey":"failed-malformed1"'),
  );

  const error = await assertRejects(
    () =>
      model.methods.drainNotifications.execute(
        {
          notifications: [caller],
          transportResults: [{ dedupKey: caller.dedupKey, delivered: true }],
        },
        test.context,
      ),
    Error,
    "Persisted notification record is invalid",
  );
  assertEquals(error.message, "Persisted notification record is invalid");
  assertEquals(test.getWrittenResources().length, 0);
});

Deno.test("ordinary drain success and failure still write authoritative records", async () => {
  const test = testContext();
  const success = pendingNotification("failed-success11");
  const failure = NotificationSchema.parse({
    ...pendingNotification("completed-failure1"),
    event: "completed",
  });
  test.setLatestResource("notification-WI-800-failed", success);
  test.setLatestResource("notification-WI-800-completed", failure);

  const result = await model.methods.drainNotifications.execute(
    {
      notifications: [success, failure],
      transportResults: [
        { dedupKey: success.dedupKey, delivered: true },
        { dedupKey: failure.dedupKey, delivered: false },
      ],
    },
    test.context,
  );

  assertEquals(result.dataHandles?.length, 2);
  const written = test.getWrittenResources().map((resource) =>
    NotificationSchema.parse(resource.data)
  );
  assertEquals(written[0].status, "delivered");
  assertEquals(written[0].attempts, 0);
  assertEquals(written[1].status, "failed");
  assertEquals(written[1].attempts, 1);
});

Deno.test("drainNotifications method rewrites only notification records", async () => {
  const test = testContext();
  const pending = pendingNotification("failed-cccc3333");
  test.setLatestResource("notification-WI-800-failed", pending);
  await model.methods.drainNotifications.execute(
    {
      notifications: [pending],
      transportResults: [
        {
          dedupKey: "failed-cccc3333",
          delivered: false,
          error: "transport down",
        },
      ],
    },
    test.context,
  );
  const written = test.getWrittenResources();
  // Exactly one write — the updated notification record.
  assertEquals(written.length, 1);
  assert(written[0].name.startsWith("notification-"));
  const updated = written[0].data as unknown as z.infer<
    typeof NotificationSchema
  >;
  assertEquals(updated.status, "failed");
  assertEquals(updated.attempts, 1);
  // Every write targets the notification spec — no other resource kind leaks in.
  for (const resource of written) {
    assertEquals(resource.specName, "notification");
    assert(resource.name.startsWith("notification-"));
  }
});
