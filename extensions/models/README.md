# @mgreten/notification-outbox

A transport-neutral, secret-redacting notification outbox for
[swamp](https://swamp.club) workflows. It splits notification delivery into two
network-free, unit-testable halves so the model never performs transport I/O
itself: `enqueueNotification` writes a durable, redacted, deduplicated
notification record, and `drainNotifications` folds caller-supplied transport
results back into those records. Payloads are redacted **before** they are
stored — credential-shaped values, keys such as
`token`/`password`/`authorization`, and absolute host paths are masked with
`[REDACTED]`, so secrets and host layout never reach durable storage.
Deduplication is scoped to a caller-supplied `era` token: reusing an era
suppresses a repeated event, while a fresh era re-notifies.

This model ships **no transport**. Pair it with a transport model of your choice
— [`@mgreten/ntfy-notify`](https://github.com/meagerfindings/swamp-ntfy-notify)
is the closest precedent — by running the transport in your workflow and passing
its results back into `drainNotifications`.

## Installation

```sh
swamp extension pull @mgreten/notification-outbox
```

## Setup

The model has no required global arguments. Create an instance:

```sh
swamp model create outbox \
  --type @mgreten/notification-outbox \
  --type-version 2026.08.01.1
```

## Usage

Enqueue a redacted, deduplicated notification for an event on a work item. The
`era` scopes deduplication. Ordinary retries do not need to pass `existing`: the
method reads the latest record for the stable notification instance and
atomically skips an identical pending/delivered event:

```sh
swamp model method run outbox enqueueNotification \
  --arg workItem=WI-801 \
  --arg event=completed \
  --arg urgency=default \
  --arg era=2026-07-20T00:00:00.000Z \
  --arg-json payload='{"prUrl":"https://github.com/acme/app/pull/7","token":"sk-xyz"}'
```

Drain the pending records after your workflow has run its transport. Feed back
one transport result per `dedupKey`; a `delivered:true` marks the record
delivered, anything else bumps `attempts` and records a non-data-bearing
classified `lastError` when an error was supplied:

```sh
swamp model method run outbox drainNotifications \
  --arg-json notifications='[{"workItem":"WI-801","event":"completed","urgency":"default","dedupKey":"completed-1a2b3c4d","era":"2026-07-20T00:00:00.000Z","payload":{},"status":"pending","attempts":0,"enqueuedAt":"2026-07-20T00:00:00.000Z","updatedAt":"2026-07-20T00:00:00.000Z","policyVersion":"1","redactionVersion":"1"}]' \
  --arg-json transportResults='[{"dedupKey":"completed-1a2b3c4d","delivered":true}]'
```

## Global Arguments

| Argument | Type | Default | Description                              |
| -------- | ---- | ------- | ---------------------------------------- |
| _(none)_ | —    | —       | This model requires no global arguments. |

## Method: enqueueNotification

Enqueue a transport-neutral, redacted notification, deduplicated on
`(workItem, event, era)`. Returns no data handle on a dedup hit.

| Argument   | Type                                         | Default   | Description                                                                                                                        |
| ---------- | -------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `workItem` | string (path-safe)                           | —         | The work item the notification is about.                                                                                           |
| `event`    | `approval-needed` \| `failed` \| `completed` | —         | The event kind.                                                                                                                    |
| `urgency`  | `low` \| `default` \| `high` \| `urgent`     | `default` | Delivery urgency hint for the transport.                                                                                           |
| `era`      | string                                       | —         | Dedup scope token (an ISO timestamp works well).                                                                                   |
| `payload`  | object                                       | `{}`      | Arbitrary context; redacted before storage.                                                                                        |
| `existing` | notification record \| null                  | —         | Migration/backward-compatibility fallback used only when this instance has no persisted record. Not required for ordinary retries. |

## Method: drainNotifications

Fold pending records with the transport results the caller obtained, marking
each `delivered` or `failed`. Idempotent: a delivered record is terminal; a
record with no matching transport result is left untouched.

| Argument           | Type                                       | Default | Description                           |
| ------------------ | ------------------------------------------ | ------- | ------------------------------------- |
| `notifications`    | array of notification records              | —       | The pending records to drain.         |
| `transportResults` | array of `{ dedupKey, delivered, error? }` | —       | One transport outcome per `dedupKey`. |

## How It Works

`enqueueNotification` redacts the payload, computes a stable FNV-1a `dedupKey`
over `(workItem, event, era)`, and writes a `notification` resource named
`notification-<workItem>-<event>`. Before deriving or writing a new record, it
reads and strictly validates the authoritative latest persisted value for that
same instance. A prior `pending`/`delivered` record with the same `dedupKey` is
a dedup hit (nothing is written); a prior `failed` record or one from a
different era is re-enqueueable. Persisted state always wins over
caller-supplied `existing`; that argument remains only as a
migration/backward-compatibility fallback when no persisted instance exists.
Malformed persisted data fails closed without writing.

This read/derive/write sequence is atomic because Swamp serializes methods with
its per-model-instance method lock. Deployments embedding the model must retain
that locking guarantee; the model does not add a separate cross-process lock.

`drainNotifications` performs a pure fold over the pending records and the
transport results — no external reads, no transport calls. A `delivered:true`
result marks the record delivered; anything else sets `failed`, increments
`attempts`, and records the fixed classification `transport delivery failed` as
`lastError` when the caller supplied any error. Raw transport errors are never
persisted, regardless of their contents; callers should keep transport
diagnostics outside the outbox. When the result omits `error`, the record also
omits `lastError`. Re-draining a delivered record is a no-op, and a record
without a matching result stays pending. The only dependency is `npm:zod@4` for
schema validation.

### Redaction version upgrades

Newly enqueued records are stamped with `redactionVersion: "2"`, covering
payload redaction and non-data-bearing transport-error classification. Persisted
version `"1"` records remain valid inputs and can still be drained; draining
does not rewrite their version. This preserves existing outboxes while ensuring
all newly created records use the stronger policy.

## License

MIT — see LICENSE for details.
