# @spfn/notification

> **The messages your product has to send before it has anything to say**

A verification code. A password reset. An invitation. A receipt. None of these are your
product, and all of them are required before it ships. `@spfn/auth` already emits the
events — registration, invitation created, invitation accepted — and this package is what
turns those into a delivered email or SMS.

Multi-channel delivery for SPFN applications: one call site, a provider behind it, and a
record of what was sent.

## What you get

- **Multi-channel support**: Email, SMS, Slack, native push (FCM: Android, iOS, web)
- **Provider pattern**: Pluggable providers (AWS SES, AWS SNS, etc.)
- **Template system**: Variable substitution with filters
- **Scheduled delivery**: Schedule notifications for later via pg-boss
- **History tracking**: Optional notification history with database storage
- **Email tracking**: Open pixel & click redirect tracking with engagement analytics

## Installation

```bash
pnpm add @spfn/notification drizzle-orm@1.0.0-rc.4
```

### Optional Dependencies

Install providers as needed:

```bash
# For AWS SES v2 (Email)
pnpm add @aws-sdk/client-sesv2

# For AWS SNS (SMS)
pnpm add @aws-sdk/client-sns
```

## Quick Start

```typescript
import { sendEmail, sendSMS, configureNotification } from '@spfn/notification/server';

// Configure (optional - uses environment variables by default)
configureNotification({
    email: {
        from: 'noreply@example.com',
    },
    defaults: {
        appName: 'MyApp',
    },
});

// Send email with template
await sendEmail({
    to: 'user@example.com',
    template: 'verification-code',
    data: { code: '123456' },
});

// Send SMS
await sendSMS({
    to: '+821012345678',
    template: 'verification-code',
    data: { code: '123456' },
});
```

## Configuration

### Environment Variables

```bash
# Email
SPFN_NOTIFICATION_EMAIL_PROVIDER=aws-ses
SPFN_NOTIFICATION_EMAIL_FROM=noreply@example.com

# SMS
SPFN_NOTIFICATION_SMS_PROVIDER=aws-sns

# Tracking
SPFN_NOTIFICATION_TRACKING_ENABLED=true
SPFN_NOTIFICATION_TRACKING_SECRET=your-hmac-secret-key
SPFN_NOTIFICATION_TRACKING_BASE_URL=https://api.example.com

# History (only needed when history.storeRecipient is 'hashed')
SPFN_NOTIFICATION_HISTORY_HASH_SECRET=your-history-hmac-secret

# AWS Credentials
AWS_REGION=ap-northeast-2
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
```

### Code Configuration

```typescript
import { configureNotification } from '@spfn/notification/server';

configureNotification({
    email: {
        provider: 'aws-ses',
        from: 'noreply@example.com',
        replyTo: 'support@example.com',
    },
    sms: {
        provider: 'aws-sns',
        defaultCountryCode: '+82',
    },
    defaults: {
        appName: 'MyApp',
    },
    enableHistory: true, // Enable notification history tracking
    history: {
        storeContent: true,       // Store rendered content + template data (default: true)
        storeRecipient: 'raw',    // 'raw' | 'hashed' — how the recipient column is stored
        // hashSecret: '...',     // Required for 'hashed' (or use the env var)
    },
    tracking: {
        enabled: true,                          // Enable email tracking
        secret: 'your-hmac-secret-key',         // HMAC signing key
        baseUrl: 'https://api.example.com',     // Tracking endpoint URL
    },
});
```

## Sending Notifications

### Email

```typescript
import { sendEmail, sendEmailBulk } from '@spfn/notification/server';

// With template
await sendEmail({
    to: 'user@example.com',
    template: 'welcome',
    data: { name: 'John' },
});

// With direct content
await sendEmail({
    to: 'user@example.com',
    subject: 'Hello',
    text: 'Plain text content',
    html: '<h1>HTML content</h1>',
});

// Bulk send (in-process, parallel)
await sendEmailBulk([
    { to: 'user1@example.com', template: 'welcome', data: { name: 'John' } },
    { to: 'user2@example.com', template: 'welcome', data: { name: 'Jane' } },
], { concurrency: 20 });

// Bulk send (distributed across instances via pg-boss)
const result = await sendEmailBulk(items, { distributed: true });
// result.batchId — UUID for tracking this batch
// Actual sending happens in background via pg-boss workers
```

### SMS

```typescript
import { sendSMS, sendSMSBulk } from '@spfn/notification/server';

// With template
await sendSMS({
    to: '+821012345678',
    template: 'verification-code',
    data: { code: '123456' },
});

// With direct message
await sendSMS({
    to: '010-1234-5678', // Auto-normalized to E.164 format
    message: 'Your code is 123456',
});
```

## Push (FCM)

Native push goes through Firebase Cloud Messaging's HTTP v1 API, which reaches Android,
iOS (FCM relays to APNs — upload your APNs auth key in the Firebase console) and web.

### Setup

```bash
pnpm add google-auth-library        # optional peer dependency, needed only for push
```

| Variable | Meaning |
|---|---|
| `SPFN_NOTIFICATION_FCM_SERVICE_ACCOUNT` | Service-account JSON. Unset: Application Default Credentials (GKE Workload Identity, `gcloud auth application-default login`) |
| `SPFN_NOTIFICATION_FCM_PROJECT_ID` | Firebase project id; defaults to the credential's project |
| `SPFN_NOTIFICATION_PUSH_PROVIDER` | `fcm` (default), or the name of a provider passed to `registerPushProvider` |

### Device tokens

The package stores tokens but ships no route: registering a token must be tied to the
signed-in user, and the package does not depend on auth. Call it from your own
authenticated route and pass your user id as a string.

```typescript
import { registerPushDevice, unregisterPushDevice } from '@spfn/notification/server';

// after sign-in, and whenever the app gets a new FCM token
await registerPushDevice({
    ownerId: String(auth.userId),
    token: body.fcmToken,
    platform: 'ios',            // 'ios' | 'android' | 'web'
    deviceId: body.installId,   // optional, recommended
    locale: body.locale,        // optional: renders localised templates per device
});

// on sign-out
await unregisterPushDevice(body.fcmToken);
```

- A token registered by another owner moves to the new one, so a shared device that
  signs in as someone else stops receiving the previous user's pushes.
- With `deviceId`, a rotated token replaces the device's old one (one active token per
  device, whoever owned it). Take `deviceId` from the device itself (an install id the
  app generates), never from user input: anyone who can name another user's `deviceId`
  can retire that device's token.
- FCM answering `UNREGISTERED` or `SENDER_ID_MISMATCH` invalidates the token. So does
  `INVALID_ARGUMENT` whose field violation names `message.token` (a malformed token);
  an `INVALID_ARGUMENT` about any other field is a payload error and leaves the token
  alone, since otherwise one bad payload would wipe every token it was sent to.

### Sending

```typescript
import { sendPush } from '@spfn/notification/server';

// every active device of the user
await sendPush({ to: { ownerId: userId }, title: 'Order shipped', body: '#1234', data: { orderId: '1234' } });

// narrowed: iOS only / named devices / the device used last
await sendPush({ to: { ownerId: userId, devices: { platforms: ['ios'] } }, title: '…' });
await sendPush({ to: { ownerId: userId, devices: { deviceIds: ['install-1'] } }, title: '…' });
await sendPush({ to: { ownerId: userId, devices: { latest: 1 } }, title: '…' });

// tokens you manage yourself
await sendPush({ to: { tokens: [a, b] }, title: '…' });
```

Which devices get a push is the caller's decision; the default is all of the owner's
active devices. For a rule the selector cannot express, read `listPushDevices(ownerId)`
and pass `{ tokens }`.

The result is per device, with masked tokens:

```typescript
{
    success: false,             // true only when every device succeeded
    successCount: 1,
    failureCount: 1,
    results: [
        { token: 'dF3k9a…x81Q', deviceId: 'install-1', platform: 'ios', success: true, messageId: '…' },
        { token: 'c2Pq0Z…7tLm', platform: 'android', success: false, error: 'UNREGISTERED: …' },
    ],
}
```

An owner with no active device returns `success: false, error: 'no_devices'`.

- `data` values must be strings (FCM's rule); a payload over 4096 bytes is refused before
  sending.
- `options`: `priority` (`high`/`normal`), `ttlSeconds`, `collapseKey`, `badge`, `sound`,
  `contentAvailable` (silent push: data only, wakes the app). They are mapped onto the
  Android, APNs and web blocks. `fcm` takes raw FCM `message` fields, merged last.
- Templates take `push: { title, body, data }`, also per locale. A registered device's
  `locale` wins over the send's `locale`.
- `idempotencyKey` applies per device: a retry reaches only the devices that did not get
  it. `sensitive: true` keeps title and body out of history.
- `sendPushBulk(items)` sends several pushes with bounded concurrency.

### Scheduling

`schedulePush(params, options)` takes the same `ScheduleOptions` as email and SMS
(`scheduledAt`, `referenceType`/`referenceId`, `guard`, cancellation). Devices are
resolved when the job runs, so a device registered in between is included, and a
retry after a partial failure reaches only the devices that failed.

Delivery through FCM and APNs is best effort: an accepted message can still be dropped
without the sender being told. Do not build anything that needs a push to arrive.

## Scheduled Notifications

Schedule notifications for later delivery using pg-boss:

```typescript
import { scheduleEmail, scheduleSMS } from '@spfn/notification/server';

// Schedule email for 1 hour later
const result = await scheduleEmail(
    {
        to: 'user@example.com',
        template: 'reminder',
        data: { eventName: 'Meeting' },
    },
    {
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
        referenceType: 'event',
        referenceId: 'event-123',
    }
);

// Cancel scheduled notification
import { cancelNotification } from '@spfn/notification/server';
const cancel = await cancelNotification(result.notificationId);
// { success: true, jobCancelled: true }
```

**What a cancel guarantees.** `success: true` means the notification will not be sent.
The history row moves from `scheduled` to `cancelled` in one status-guarded update, and
the scheduled job re-checks the row when it runs: it sends only a row it can move to
`pending`, and skips a `cancelled` or `sent` row without error. So a cancel holds even
when the queued job could not be removed (`jobCancelled: false` — no queue in this
process, or a queue error) and even when it races the send time. Whichever of the cancel
and the job updates the row first wins; the other sees the new status and stands down.

A cancel also works on a row whose attempt `failed` and is waiting for a job retry. It is
refused (`success: false`) for a send in progress or already sent. `markNotificationCancelled(id)` is the record-only
form: it updates the row and returns whether it did, without touching the queue.

### Send guards — "send this later, unless it no longer applies"

A scheduled send can name a guard that the job calls when it runs, after checking the
row was not cancelled. It answers the question the app could not answer at schedule
time, so the app does not have to race a cancel against the send time.

```typescript
import { registerSendGuard, scheduleEmail } from '@spfn/notification/server';

// Register in every process that runs notification jobs.
registerSendGuard('incident-still-open', async ({ referenceId }) =>
{
    return (await incidents.find(referenceId))?.status === 'open';
});

await scheduleEmail(
    { to: oncall, template: 'outage', data: { incidentId } },
    {
        scheduledAt: new Date(Date.now() + 10 * 60 * 1000),
        referenceType: 'incident',
        referenceId: incidentId,
        guard: 'incident-still-open',
    },
);
```

The guard receives `{ notificationId, channel, referenceType, referenceId, data }`.

| The guard | Row | Sent | Job |
|---|---|---|---|
| returns `true` | `sent` | yes | done |
| returns `false` | `skipped` | no | done, no retry |
| throws | `failed` | no | retried; the guard runs again |
| is not registered when the job runs | `failed` (`Send guard not registered: …`) | no | done, no retry |

An unknown guard name is refused when scheduling (`success: false`), before anything is
queued. A cancelled row never reaches its guard.

## Retries without duplicates (idempotency keys)

A send can be retried safely by giving it an `idempotencyKey`. The first send with a key
records it on the history row; a later send with the same key, channel and recipient
returns the first result without calling the provider.

```typescript
const result = await sendEmail({
    to: user.email,
    template: 'payment-failed',
    data: { invoiceId },
    idempotencyKey: `invoice-${invoiceId}:payment-failed`,
});
// retry → { success: true, messageId: '<first>', deduplicated: true }
```

**The key must come out the same on every retry.** Derive it from the business event,
or generate a UUID once and store it with the job that sends. A `crypto.randomUUID()`
called right before each send gives every attempt a new key and deduplicates nothing.

| First send's row | A repeat with the same key |
|---|---|
| `sent` | returns the first result, `deduplicated: true` |
| `failed` | takes over the same row and sends again |
| `pending` / `scheduled` (in flight) | `success: false`, `error: 'send in progress'`, not sent |
| `cancelled` / `skipped` | `success: false`, `error: 'already cancelled'` (…), not sent |

- Available on `sendEmail`, `sendSMS`, `sendSlack`, each bulk item, and `scheduleEmail` /
  `scheduleSMS` (a repeat schedule returns the first `notificationId` and queues nothing).
- The key is unique per channel and recipient: one key can cover an email and an SMS, and
  an SMS to several numbers is deduplicated number by number.
- 1–255 characters (`MAX_IDEMPOTENCY_KEY_LENGTH`). Requires `enableHistory: true`; a
  keyed send is refused when history is off, and when the key cannot be recorded, rather
  than sent without protection.
- A keyed send that takes over a `failed` row also takes it away from the queued job that
  failed it: that job's retry finds the row no longer its own and sends nothing.
- A process that dies after claiming a key and before the provider answers leaves the row
  `pending`, and the key stays blocked. The provider may already have delivered, so it
  is not retried automatically: after checking, `markNotificationFailed(id, reason)` frees
  it.

## Bulk Sending

All channels support bulk sending with two modes:

### In-Process Mode (default)

Sends all items in the current process with concurrency control.
Suitable for single-instance deployments or smaller batches.

```typescript
import { sendEmailBulk, sendSMSBulk, sendSlackBulk } from '@spfn/notification/server';

const result = await sendEmailBulk(items, { concurrency: 20 });
// result.results — SendResult[] in same order as input
// result.successCount / result.failureCount
// result.batchId — UUID for this batch
```

### Distributed Mode

Enqueues items to pg-boss for processing across multiple instances.
Each instance's worker fetches 50 items at a time and processes them in parallel.
Failed items are individually retried by pg-boss.

```typescript
const result = await sendEmailBulk(items, { distributed: true });
// Returns immediately with pending results
// result.results[i].messageId === 'pending:{batchId}'
```

**Distributed mode flow:**
1. Validates and renders templates
2. Batch inserts notification records (single query)
3. Applies tracking (email only)
4. Bulk inserts pg-boss jobs via `sendBatch()`
5. Returns immediately — workers process in background

**Requirements:**
- `notificationJobRouter` must be registered (see Job Router Setup below)
- pg-boss must be initialized

### Job Router Setup

Register the notification job router with your server:

```typescript
import { defineServerConfig } from '@spfn/core/server';
import { defineJobRouter } from '@spfn/core/job';
import { notificationJobRouter } from '@spfn/notification/server';

defineServerConfig()
    .jobs(defineJobRouter({
        notification: notificationJobRouter,
    }))
    .build();
```

## Template System

### Built-in Templates

| Name | Channels | Purpose |
|------|----------|---------|
| `verification-code` | email, sms | Verification codes |
| `welcome` | email | Welcome message |

### Custom Templates

```typescript
import { registerTemplate } from '@spfn/notification/server';

registerTemplate({
    name: 'order-confirmation',
    channels: ['email', 'sms'],

    email: {
        subject: '[{{appName}}] Order Confirmed',
        html: `
            <h1>Order #{{orderId}}</h1>
            <p>Thank you, {{userName}}!</p>
            <p>Total: {{amount | currency}}</p>
        `,
        text: 'Order #{{orderId}} confirmed. Total: {{amount}}',
    },

    sms: {
        message: '[{{appName}}] Order #{{orderId}} confirmed. Total: {{amount | currency}}',
    },
});
```

### Localised Templates

A template can carry content per locale. A send picks one with `locale`:

```typescript
registerTemplate({
    name: 'order-shipped',
    channels: ['email', 'sms'],
    defaultLocale: 'en',
    locales: {
        ko: { email: { subject: '{{orderId}} 주문이 발송되었습니다', text: '…' }, sms: { message: '…' } },
        en: { email: { subject: 'Order {{orderId}} has shipped', text: '…' } },
    },
});

await sendEmail({ to, template: 'order-shipped', data: { orderId }, locale: user.locale });
```

- Resolution: the exact tag (`ko-KR`), then its base language (`ko`), then `defaultLocale`,
  then the template's unlocalised `email`/`sms`/`slack` content. Tags match
  case-insensitively.
- It resolves per channel. A locale that has no content for the channel falls through to
  the next candidate. In the example, an SMS with `locale: 'en'` finds no `en` SMS, then no
  unlocalised SMS, and is refused; with `locale: 'ko'` it is sent in Korean.
- A template with `locales` that has nothing for the channel in any candidate is refused
  (`success: false`) instead of sending empty content. A template without `locales`
  behaves as before.
- The history row records the locale whose content was sent (`null` for unlocalised
  content).
- `locale` works on every send, bulk item and schedule; a scheduled send renders in it
  when the job runs.

### Template Filters

```
{{variable}}              - Basic substitution
{{variable | uppercase}}  - Convert to uppercase
{{variable | lowercase}}  - Convert to lowercase
{{variable | currency}}   - Format as currency (1,000)
{{variable | date}}       - Format as date
{{variable | date:YYYY-MM-DD}} - Custom date format
{{variable | truncate:20}} - Truncate to length
{{variable | default:N/A}} - Default value if empty
```

### Custom Filters

```typescript
import { registerFilter } from '@spfn/notification/server';

registerFilter('phone', (value) => {
    const str = String(value);
    return `${str.slice(0, 3)}-${str.slice(3, 7)}-${str.slice(7)}`;
});

// Usage: {{phoneNumber | phone}} -> 010-1234-5678
```

## Custom Providers

### Email Provider

```typescript
import { registerEmailProvider, EmailProvider } from '@spfn/notification/server';

const sendgridProvider: EmailProvider = {
    name: 'sendgrid',
    async send(params) {
        // Your SendGrid implementation
        return { success: true, messageId: '...' };
    },
};

registerEmailProvider(sendgridProvider);
```

### SMS Provider

```typescript
import { registerSMSProvider, SMSProvider } from '@spfn/notification/server';

const twilioProvider: SMSProvider = {
    name: 'twilio',
    async send(params) {
        // Your Twilio implementation
        return { success: true, messageId: '...' };
    },
};

registerSMSProvider(twilioProvider);
```

## Logging & Error Handling

All channels log via `@spfn/core/logger`. Logs are tagged by channel.

**Recipient fields never appear raw in logs.** Every recipient field this
package writes — success, failure, and validation logs alike — carries a masked
value (`jo***@example.com`, `+8210******78`). A send resolved as `sensitive`
(see [Sensitive sends](#sensitive-sends)) also keeps its subject out of the log,
because a verification subject line carries the code itself; the log identifies
the send by template name instead. The masking helpers are exported
(`maskEmail`, `maskPhone`, `maskRecipient`, `maskRecipients`) for application-side
logging of the same values.

**Provider error text is scrubbed too.** A provider failure is free text and
routinely quotes the recipient back — an SES sandbox `MessageRejected` reads
*"The following identities failed the check in region US-EAST-1:
learner@example.com"*. Every provider error is scrubbed of email and phone
tokens before it reaches a log line or `history.error_message`, at the channel's
provider boundary — so a custom provider (see [Custom Providers](#custom-providers))
is covered without doing anything — and again in the service that writes the
column. Only address-shaped tokens are replaced: the error *name* (`MessageRejected`),
the region, the request id, timestamps and message ids are the diagnostic value
and survive untouched, and the built-in AWS providers log that name and the HTTP
status alongside the scrubbed message. `scrubProviderError(text)` is exported for
applications that log provider errors themselves.

Channel tags:

- `@spfn/notification:email` — Email send success/failure, validation errors
- `@spfn/notification:sms` — SMS send success/failure, validation errors
- `@spfn/notification:slack` — Slack send success/failure, validation errors
- `@spfn/notification:ses` — AWS SES client lifecycle, provider errors
- `@spfn/notification:sns` — AWS SNS client lifecycle, provider errors

`sendEmail`, `sendSMS`, `sendSlack` are designed to **not throw** — they return a `SendResult` object. Always check the result:

```typescript
const result = await sendEmail({
    to: 'user@example.com',
    template: 'welcome',
    data: { name: 'John' },
});

if (!result.success)
{
    // result.error contains the failure reason
    console.error('Email failed:', result.error);
}
```

## Notification History

Enable history tracking to store all notifications in the database:

```typescript
configureNotification({
    enableHistory: true,
});
```

### What a row stores — and how to store less

A history row is the anchor for tracking (FK), scheduling (cancellation) and
bulk status, so the row itself is always created when history is enabled. What
lands **in** it is configurable, because two of its columns are privacy
surfaces: `recipient` is a person's address, and `content` / `template_data`
can carry a live credential (a magic link, an OTP code). `error_message` holds
the scrubbed provider message, so a row whose `recipient` is hashed cannot carry
the raw address in its failure text either.

```typescript
configureNotification({
    enableHistory: true,
    history: {
        // Keep rendered content and template data out of every row.
        // Status, provider message id, error and timestamps still land.
        storeContent: false,

        // Store an HMAC per recipient instead of the raw address.
        // findNotifications({ recipient }) keeps working — the filter is
        // hashed the same way. Requires a secret (config or
        // SPFN_NOTIFICATION_HISTORY_HASH_SECRET). A plain hash would be
        // reversible by dictionary, which is why a keyed HMAC is used.
        storeRecipient: 'hashed',
    },
});
```

Neither option needs a migration — the payload columns are nullable and the
HMAC satisfies the `recipient` column as-is.

### Sensitive sends

A send whose rendered output *is* a credential can opt out of payload storage
per send, regardless of the global `storeContent` setting:

```typescript
await sendEmail({
    to: 'user@example.com',
    subject: 'Your access link',
    html: accessLinkHtml,
    sensitive: true,    // no content, template data, or subject in the history row
});
```

A template can declare it for every send that uses it — the built-in
`verification-code` template does, since both its body and its subject line
contain the code. A per-send `sensitive: true/false` overrides the template's
declaration.

**Scheduled and distributed sends caveat:** a scheduled send's payload (raw
recipient, content, template data) necessarily travels through the pg-boss job
table — that is what gets sent later — and stays there until pg-boss archives
the job. The same applies to `sendEmailBulk` / `sendSMSBulk` with
`distributed: true`. The history options above do not change that. If your
contract forbids persisting a credential at all, send it immediately and
in-process rather than scheduling or distributing it.

### Query History

```typescript
import {
    findNotifications,
    getNotificationStats,
    findScheduledNotifications,
} from '@spfn/notification/server';

// Find notifications
const notifications = await findNotifications({
    channel: 'email',
    status: 'sent',
    recipient: 'user@example.com',
    from: new Date('2024-01-01'),
    limit: 100,
});

// Get statistics
const stats = await getNotificationStats({ channel: 'email' });
// { total: 1000, scheduled: 10, pending: 5, sent: 980, failed: 3, cancelled: 2 }

// Find scheduled notifications
const scheduled = await findScheduledNotifications({
    channel: 'email',
    from: new Date(),
    to: new Date(Date.now() + 24 * 60 * 60 * 1000),
});
```

## Email Tracking

Track email opens and link clicks to measure engagement.

### How It Works

1. **Open tracking**: A 1x1 transparent GIF is inserted before `</body>`. When the email client loads the image, an open event is recorded.
2. **Click tracking**: `<a href>` links are wrapped with redirect URLs. When clicked, a click event is recorded and the user is redirected to the original URL.
3. Links with `mailto:`, `tel:`, `sms:`, `javascript:`, and `#` protocols are automatically skipped.
4. **URL fragments stay client-side.** A fragment (`#token=...`) is never sent to a server on a normal navigation — magic links carry their secret there for exactly that reason — so the rewriter keeps it out of the redirect's query string. Only the fragment-less URL is signed, sent, and recorded; the fragment rides on the tracking URL itself, and since the 302 `Location` carries no fragment, the browser re-attaches it to the destination. The click is still counted.
5. **Per-link opt-out**: a link with a `data-no-track` attribute is left completely untouched — no rewrite, no record.

```html
<!-- tracked; #token=... never reaches the tracking endpoint -->
<a href="https://app.example.com/access#token=abc">Open your access page</a>

<!-- not tracked at all -->
<a data-no-track href="https://app.example.com/access#token=abc">Open</a>
```

### Setup

Tracking requires:
- `enableHistory: true` (tracking events reference the history table via FK)
- `tracking.secret` configured (HMAC token signing)
- `tracking.baseUrl` configured (where tracking endpoints are accessible)
- `trackingRouter` registered in your app router

```typescript
import { configureNotification, trackingRouter } from '@spfn/notification/server';
import { defineRouter } from '@spfn/core/route';

configureNotification({
    enableHistory: true,
    tracking: {
        enabled: true,
        secret: 'your-hmac-secret-key',
        baseUrl: 'https://api.example.com',
    },
});

// Register tracking router (provides /_noti/t/o/:token and /_noti/t/c/:token)
const appRouter = defineRouter({ ... })
    .packages([trackingRouter]);
```

### Per-Email Control

Override the global tracking setting for individual emails:

```typescript
// Force tracking on for this email (even if globally disabled)
await sendEmail({
    to: 'user@example.com',
    template: 'campaign',
    data: { ... },
    tracking: true,
});

// Force tracking off for this email (even if globally enabled)
await sendEmail({
    to: 'admin@example.com',
    subject: 'Internal Report',
    html: '<p>...</p>',
    tracking: false,
});
```

### Priority

```
sendEmail({ tracking: true/false })              ← 1st: per-call override
configureNotification({ tracking: { enabled } }) ← 2nd: code config
SPFN_NOTIFICATION_TRACKING_ENABLED=true           ← 3rd: environment variable
```

### Tracking Endpoints

These endpoints skip authentication (accessed by email clients):

| Endpoint | Response | Action |
|----------|----------|--------|
| `GET /_noti/t/o/:token` | 200 + 1x1 GIF | Records open event |
| `GET /_noti/t/c/:token?url=...` | 302 redirect | Records click event, redirects to original URL |

- An invalid open token still returns the pixel (UX protection); an invalid click token returns 404 — redirecting on an unverified token would be an open redirect
- `Cache-Control: no-store` for re-open tracking
- DB writes are fire-and-forget (response speed first)

### Analytics

```typescript
import {
    getTrackingStats,
    getEngagementStats,
    getClickDetails,
} from '@spfn/notification/server';

// Stats for a specific notification
const stats = await getTrackingStats(notificationId);
// { totalOpens: 15, uniqueOpens: 8, totalClicks: 5, uniqueClicks: 3 }

// Overall engagement stats
const engagement = await getEngagementStats({ channel: 'email' });
// { sent: 1000, opened: 450, clicked: 120, openRate: 45.00, clickRate: 12.00 }

// Click details per link
const clicks = await getClickDetails(notificationId);
// [{ linkUrl: 'https://...', linkIndex: 0, totalClicks: 5, uniqueClicks: 3 }]
```

Unique counts are based on distinct IP addresses.

### Limitations

- **Open tracking is approximate**: Email clients like Apple Mail Privacy Protection may pre-fetch images, inflating open counts.
- Tracking auto-disables when `enableHistory: false` (FK dependency) or `tracking.secret` is not set.

## API Reference

### Exports

```typescript
// From '@spfn/notification'
export type {
    NotificationChannel,
    SendResult,
    SendEmailParams,
    SendSMSParams,
    SendSlackParams,
    TemplateDefinition,
    TemplateData,
};

// From '@spfn/notification/server'
export {
    // Configuration
    configureNotification,
    getNotificationConfig,

    // Email
    sendEmail,
    sendEmailBulk,
    registerEmailProvider,
    type BulkEmailResult,
    type BulkEmailOptions,

    // SMS
    sendSMS,
    sendSMSBulk,
    registerSMSProvider,
    type BulkSMSResult,
    type BulkSMSOptions,

    // Slack
    sendSlack,
    sendSlackBulk,
    registerSlackProvider,
    type BulkSlackResult,
    type BulkSlackOptions,

    // Scheduling
    scheduleEmail,
    scheduleSMS,
    cancelNotification,

    // Templates
    registerTemplate,
    renderTemplate,
    registerFilter,

    // History
    findNotifications,
    getNotificationStats,

    // Tracking
    trackingRouter,
    processTrackingHtml,
    getTrackingStats,
    getEngagementStats,
    getClickDetails,
    isTrackingEnabled,

    // Jobs
    notificationJobRouter,
    sendBulkEmailItemJob,
    sendBulkSmsItemJob,
    sendBulkSlackItemJob,
};
```

## License

MIT
