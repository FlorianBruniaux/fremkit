# Read-only Google services

Gmail and Google Calendar publish separate connection service channels using the same Google account connection. OAuth setup and secret storage are owned by the Google connection type. Neither provider has a write API, and the existing ICS channel remains unchanged.

## Registration

```ts
import { createGoogleType } from '../connections/types/google.js'
import { createGmailProvider } from '../providers/gmail.js'
import { createGoogleCalendarProvider } from '../providers/google-calendar.js'

const google = createGoogleType([
  { id: 'gmail', channelPrefix: 'gmail', createProvider: createGmailProvider },
  { id: 'google-calendar', channelPrefix: 'google-calendar', createProvider: createGoogleCalendarProvider },
])
```

The manager supplies `ConnectionServiceContext`: connection ID, channel, selected plain fields, secrets and an account generation. Construction is inert. Shared `createGoogleClient` owns granted capabilities, fixed origins, deadlines, capped JSON, token refresh, and generation cancellation. Providers never accept API paths or URLs from widgets.

## Payloads

Both payloads carry `connectionId`, display-only `account: { email } | null`, `updatedAt`, `checkedAt`, `freshness` and an error code. `updatedAt` is the last successful read; `checkedAt` is the latest completed attempt. Errors use only `unconfigured`, `unauthorized`, `forbidden`, `offline`, `timeout`, `rateLimited` or `malformed`, with no remote error message, credential or URL.

- `fresh` means the attempted reads succeeded. `stale` preserves last good data after failure. `unavailable` means no successful data exists for that part.
- Unknown collections/counts are `null`; a successful empty collection is `[]`. Widgets must preserve the distinction.
- IDs belong to their connection and calendar. Display titles, email labels and calendar names are not keys. Remote header/title strings are untrusted plain text, never HTML.
- Actions have `{ available, reason }`. Reasons are `accountRoutingUnverified`, `unsupportedDestination`, `stale` or `null`. Widgets should display the reason for unavailable actions and omit a clickable action.

The exported TypeScript interfaces in `server/src/providers/gmail.ts` and `server/src/providers/google-calendar.ts` are the payload contract.

### Gmail

Channel `gmail:<connectionId>` publishes `GmailSnapshot`. Its `messages` contain `id`, `threadId`, selected `sender`, `subject`, `date` headers, numeric `receivedAt` when available, `labels` and an `open` action. Missing headers stay `null`. `loadedCount` counts the loaded, filtered messages; `estimatedUnreadCount` comes from Google's `resultSizeEstimate` and is explicitly an estimate. `truncated` reports unfinished pagination.

Only `gmail.metadata` is required. The provider lists by both `INBOX` and `UNREAD` labels, then uses `format=metadata` and repeated `metadataHeaders` for `From`, `Subject`, and `Date`. It does not use `q`, request snippets, bodies or attachments, or modify labels/read state. The response field mask requests only the required metadata. Labels are checked again after metadata retrieval because a message can change between requests. Duplicated IDs across pages are fetched once.

Each poll performs at most three list GETs and fifty metadata GETs, with four metadata reads at a time. A failed batch drains before another poll can begin, so coalesced polling does not multiply pending reads. A failed read retains the last good message snapshot and timestamp, with stale actions. Counts are unknown until a successful read.

The [Gmail messages.list reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) defines label intersection, pagination and estimated result counts, and restricts query search under the metadata scope. [Messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get) supports selected headers in metadata format.

### Google Calendar

Channel `google-calendar:<connectionId>` publishes `GoogleCalendarSnapshot`. `calendars` contains stable `id`, display `label`, timezone, selection, events and independent freshness/error state for each calendar. `events` is the flattened selected-calendar view, preserving `connectionId`, `calendarId` and the Google event ID. Two identically named calendars or accounts remain distinct. Calendar event and recurring-parent IDs are retained exactly, with a separate 1,024-character bound that accepts generated recurring-instance suffixes; Gmail identifiers keep their independent bound.

Plain `calendarIds` is a JSON array of unique stable IDs, validated by the shared client parser, with at most fifty selections. An empty array selects the discovered primary calendar's real ID. Discovery reads at most two pages of one hundred entries. Each selected calendar reads at most two pages of one hundred events, for at most 102 provider GETs and 10,000 events per complete poll. Repeated page tokens and remaining pages set `truncated`; omitted selected calendars fail separately rather than erasing working calendars.

The window starts one hour before the poll and ends fourteen days after it. Event queries expand recurring instances using `singleEvents=true`, include cancellations and sort by start time. Cancelled instances are removed, including a cancellation repeated on a later page. Event IDs and optional `recurringEventId` survive normalization. Failed calendars retain their last good events and original timestamps; other calendars can remain fresh. Discovery failure preserves all existing selected calendars as stale. `window` is the latest requested range; stale events can originate in an earlier range.

Timed boundaries become epoch milliseconds from their offset timestamp. Explicit IANA wall times are resolved using the runtime timezone database; impossible local times fail validation, and ambiguous fall-back times use the earlier occurrence. Timezone labels remain in the payload. All-day events retain exact `startDate` and exclusive `endDate`; numeric boundaries use UTC midnight for ordering. Display all-day dates directly, rather than converting those numbers through the browser timezone.

Scopes are `calendar.calendarlist.readonly` and `calendar.events.readonly`. The provider omits descriptions, attendees, attachments, conference passwords and other unused fields. [CalendarList.list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list) describes discovery and its scope. [Events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) documents pagination, recurrence expansion and time windows; [the event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) defines exclusive ends, timezones, cancellations, HTML links and conference entry point types.

## Commands

All commands require host loopback context, strict payload schemas and exact identifiers present in the stored snapshot. Extra properties, arbitrary URLs, unknown IDs and identifiers from another connection/calendar are refused.

| Service command | Payload | Current behavior |
| --- | --- | --- |
| Gmail `open` | `{ connectionId, messageId }` | Unavailable with `accountRoutingUnverified` for a fresh loaded message. |
| Calendar `open` | `{ connectionId, calendarId, eventId }` | Unavailable with `accountRoutingUnverified` when a stored HTTPS Calendar HTML link is valid; otherwise `unsupportedDestination`. |
| Calendar `join` | `{ connectionId, calendarId, eventId }` | Re-fetches that event, validates current identity/freshness, then opens only an attached supported video destination. |

The reviewed Google API references do not establish exact browser-account selection for a Gmail message or Calendar HTML link. No numeric browser account index, email-based `authuser` heuristic, or manufactured deep link is used. These opening actions remain unavailable until a supported route and consented browser tests establish the intended account. This is a browser-account routing limit, separate from API authorization.

Meeting joins currently allow only credential-free HTTPS `meet.google.com` URLs with an exact meeting-code path, no non-default port, query or fragment, taken from a `video` conference entry point or attached `hangoutLink`. Phone, SIP, `more` entry points, descriptions, other hosts and unsupported meeting formats expose no join action. The server resolves the destination again from the current event immediately before host opening. The result does not guarantee which Google account the browser uses to join.

Actions require a successful calendar read less than 120 seconds old. A failed/stopped provider, removed grant, changed identity, aborted generation or replaced snapshot refuses opening. Revalidation rejects a changed ID, cancellation, missing meeting or malformed event. `ok: true` is returned only after the host opening function succeeds. Polling is coalesced, normally every sixty seconds, or every thirty seconds after an error. Shared-client refresh/retry exchanges are additional to the provider GET invocation bounds above.

## Verification boundary

Provider tests exercise metadata normalization, estimates, bounds, account separation, per-calendar failures, recurrence, all-day dates, timezone transitions, safe actions and cancellation. Transport integration tests use the real Google client with controlled HTTP fixtures, including repeated label/header query parameters and current-event GETs. They do not use production client stubs.

Consented Google accounts, live API metadata comparison, browser account selection, actual meeting join and XENEON touch interaction remain unverified. Fixture-backed API and host-opening tests establish only their tested behavior.
