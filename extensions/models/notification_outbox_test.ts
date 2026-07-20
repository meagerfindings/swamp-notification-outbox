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

import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  drainNotificationsFold,
  model,
  NotificationSchema,
  notificationDedupKey,
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
} {
  const written: WrittenResource[] = [];
  const context: OutboxMethodContext = {
    globalArgs: {},
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
      // deno-lint-ignore no-explicit-any
      return Promise.resolve(record as any);
    },
  };
  return { context, getWrittenResources: () => written };
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
  assertEquals(byKey.get("failed-bbbb2222")!.lastError, "connection refused");
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

Deno.test("enqueueNotification method persists a redacted pending record and dedups on retry", async () => {
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

  // A retry with the prior record as `existing` dedups: no new resource.
  await model.methods.enqueueNotification.execute(
    {
      workItem: "WI-801",
      event: "completed",
      urgency: "default",
      era: ERA_A,
      payload: {},
      existing: record,
    },
    test.context,
  );
  written = test.getWrittenResources();
  assertEquals(written.length, 1, "a dedup hit must write nothing");
});

Deno.test("drainNotifications method rewrites only notification records", async () => {
  const test = testContext();
  const pending = pendingNotification("failed-cccc3333");
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
