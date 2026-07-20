# @mgreten/notification-outbox

A transport-neutral, secret-redacting notification outbox for
[swamp](https://swamp.club) workflows. It splits notification delivery into two
network-free, unit-testable halves so the model never performs transport I/O
itself: `enqueueNotification` writes a durable, redacted, deduplicated
notification record, and `drainNotifications` folds caller-supplied transport
results back into those records. Payloads are redacted **before** they are
stored — credential-shaped values, keys such as `token`/`password`/`authorization`,
and absolute host paths are masked with `[REDACTED]`, so secrets and host layout
never reach durable storage. Deduplication is scoped to a caller-supplied `era`
token: reusing an era suppresses a repeated event, while a fresh era re-notifies.

This model ships **no transport**. Pair it with a transport model of your
choice — [`@mgreten/ntfy-notify`](https://github.com/meagerfindings/swamp-ntfy-notify)
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
  --type-version 2026.07.20.1
```

## Usage

Enqueue a redacted, deduplicated notification for an event on a work item. The
`era` scopes deduplication; pass the prior record (if any) as `existing` so an
identical pending/delivered event is skipped:

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
delivered, anything else bumps `attempts` and records `lastError`:

```sh
swamp model method run outbox drainNotifications \
  --arg-json notifications='[{"workItem":"WI-801","event":"completed","urgency":"default","dedupKey":"completed-1a2b3c4d","era":"2026-07-20T00:00:00.000Z","payload":{},"status":"pending","attempts":0,"enqueuedAt":"2026-07-20T00:00:00.000Z","updatedAt":"2026-07-20T00:00:00.000Z","policyVersion":"1","redactionVersion":"1"}]' \
  --arg-json transportResults='[{"dedupKey":"completed-1a2b3c4d","delivered":true}]'
```

## Global Arguments

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| _(none)_ | — | — | This model requires no global arguments. |

## Method: enqueueNotification

Enqueue a transport-neutral, redacted notification, deduplicated on
`(workItem, event, era)`. Returns no data handle on a dedup hit.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `workItem` | string (path-safe) | — | The work item the notification is about. |
| `event` | `approval-needed` \| `failed` \| `completed` | — | The event kind. |
| `urgency` | `low` \| `default` \| `high` \| `urgent` | `default` | Delivery urgency hint for the transport. |
| `era` | string | — | Dedup scope token (an ISO timestamp works well). |
| `payload` | object | `{}` | Arbitrary context; redacted before storage. |
| `existing` | notification record \| null | — | The prior record for this `(workItem, event)`, if any, for the dedup check. |

## Method: drainNotifications

Fold pending records with the transport results the caller obtained, marking
each `delivered` or `failed`. Idempotent: a delivered record is terminal; a
record with no matching transport result is left untouched.

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `notifications` | array of notification records | — | The pending records to drain. |
| `transportResults` | array of `{ dedupKey, delivered, error? }` | — | One transport outcome per `dedupKey`. |

## How It Works

`enqueueNotification` redacts the payload, computes a stable FNV-1a `dedupKey`
over `(workItem, event, era)`, and writes a `notification` resource named
`notification-<workItem>-<event>`. Because the dedup lives in the record's
`dedupKey`/`era` fields rather than the instance name, a caller can compute the
name in a plain expression, read the prior record back, and pass it as
`existing`. A prior `pending`/`delivered` record with the same `dedupKey` is a
dedup hit (nothing is written); a prior `failed` record or one from a different
era is re-enqueueable.

`drainNotifications` performs a pure fold over the pending records and the
transport results — no external reads, no transport calls. A `delivered:true`
result marks the record delivered; anything else sets `failed`, increments
`attempts`, and records `lastError`. Re-draining a delivered record is a no-op,
and a record without a matching result stays pending. The only dependency is
`npm:zod@4` for schema validation.

## License

MIT — see LICENSE for details.
