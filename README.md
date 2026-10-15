# PingRoom calendar reminders

Send an upcoming-event reminder to a PingRoom room from a local ICS export. Each run reads a complete calendar snapshot, finds events starting within the next 15 minutes, and records delivery results on disk. An event URL becomes an **Open event** button; explicit `GEO` coordinates become a map location.

Use this for appointment exports, team schedules, or calendars produced by your own application. This starter reads a small ICS subset; it does not connect to a calendar account or expand recurring events.

## Try it offline

Requires Node.js 22 or newer.

```sh
npm ci
npm run demo
npm test
```

The demo uses a fixed clock and temporary files: the first run simulates one reminder, and the repeated run sends zero. It reads no credentials and makes no network requests. Tests exercise the pinned CLI against a loopback mock API. Dependencies are pinned to `@pingroom/cli` 0.12.0 and `ical.js` 2.2.1.

## Connect and configure

Create a repository from this template, clone it, then:

```sh
npm ci
cp config.example.json config.json
cp .env.example .env
npm run connect
```

Follow the CLI pairing link, approve the robot in PingRoom, and choose its home room. Credentials default to this project's ignored `.pingroom/` directory. Setting `PINGROOM_HOME` in your environment or `.env` selects another credential directory. Pairing there can replace its saved connection.

For unattended use, set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM` in `.env` or your process environment. Leave both unset to use the saved connection. Partial or blank environment credentials fail; they never combine with saved values. CI requires the explicit pair. This starter uses the production PingRoom API and an agent token; it does not use ambient webhook settings.

Edit `config.json`:

```json
{
  "calendarFile": "calendar.ics",
  "stateDirectory": ".calendar",
  "leadMinutes": 15,
  "snapshotMaxAgeMinutes": 5
}
```

Paths are relative to this project, or can be absolute. Use a dedicated state directory. Both minute settings accept integers from 1 to 1440. Then publish your export and run:

```sh
npm start
```

Each invocation runs once and exits. It prints the number sent and any unresolved reminder IDs. Configuration, calendar, credentials, and state are ignored by Git.

## Produce a supported export

See [`examples/calendar.ics`](examples/calendar.ics) for the format. Its fixed 2030 dates are for the demo; use your own upcoming dates for a real run.

- Publish one complete `VCALENDAR` with `VERSION:2.0`, up to 1000 `VEVENT`s, and a maximum file size of 1 MiB.
- Every event needs one unique `UID`, `SUMMARY` (up to 200 characters), `DTSTAMP`, and `DTSTART`. Dates must use explicit UTC, such as `20301015T091000Z`, without parameters.
- Optional fields: nonnegative `SEQUENCE` (default 0), `STATUS` (`CONFIRMED`, `TENTATIVE`, or `CANCELLED`), HTTP(S) `URL`, `GEO:latitude;longitude`, and `LOCATION`. No address lookup occurs. Without `GEO`, location text appears only in the message.
- Recurrence rules/dates/exclusions, recurrence exceptions, `TZID`, floating times, all-day events, `VTIMEZONE`, nested alarms, and `METHOD` scheduling messages are rejected. Export recurring occurrences as independent UTC events with stable unique IDs upstream.
- Attendees, descriptions, and other unused event fields are not forwarded. Summaries and locations are clipped to PingRoom's display limits. Calendar content is never executed.

Validate and finish each export before replacing the active file. Write `calendar.next.ics` beside `calendar.ics`, then atomically rename it on the same filesystem:

```sh
mv /absolute/path/to/starter-calendar-reminders/calendar.next.ics /absolute/path/to/starter-calendar-reminders/calendar.ics
```

Publish a fresh complete export more often than `snapshotMaxAgeMinutes`. File modification time is the freshness signal; touching an old export does not make its contents current. Invalid or stale snapshots fail before sending.

Keep each event's UID stable. Whenever its start, summary, status, URL, or location changes, advance `DTSTAMP` or `SEQUENCE`, with neither decreasing. To cancel an unsent reminder, publish a newer `STATUS:CANCELLED` event or omit the event from the complete snapshot. A removed UID can return only with a newer revision. Earlier or conflicting revisions stop the run.

## Poll from your scheduler

Export first, then poll once per minute. For example, add this entry yourself to a local crontab after replacing the three absolute paths with your project, Node executable, and log location:

```cron
* * * * * cd /absolute/path/to/starter-calendar-reminders && /absolute/path/to/node scripts/remind.mjs >> /absolute/path/to/calendar-reminders.log 2>&1
```

This example runs every minute regardless of the machine's timezone. Event times and reminder messages are always UTC. The starter does not install a scheduler. Keep `.calendar/` on one persistent local filesystem; separate hosts or ephemeral CI jobs do not share its lock or receipts.

A reminder is eligible only while `0 < start - now <= leadMinutes`. There is no catch-up after the start time. A stopped scheduler, late export, or more than 20 due sends in one run can cause missed reminders. Poll more frequently than the lead window and keep exports fresh.

## Delivery and recovery

Receipts use UID plus start time. Restarts and cosmetic updates do not resend a delivered reminder. A newer revision that moves an event to another start time can produce a new reminder. Cancellation or removal suppresses unsent reminders; it cannot recall a reminder already delivered. The snapshot is checked again before delivery, but a calendar edit and a remote send cannot form one atomic transaction.

The starter saves a `sending` record before invoking the CLI and requires a valid notification ID before marking it `sent`. A failed request, timeout, malformed response, or crash can leave an unknown outcome. It never retries that reminder automatically. Inspect the room and resolve the ID reported by the run:

```sh
npm run resolve -- <reminder-id> confirmed
npm run resolve -- <reminder-id> abandoned
```

Use `confirmed` after verifying the reminder arrived, or `abandoned` to stop tracking it without sending again. Neither command sends a notification. Other eligible events can continue on later runs; unresolved records keep the exit status nonzero. This favors avoiding duplicates over guaranteed delivery; it does not guarantee exactly-once delivery.

Preserve and back up `.calendar/state.json`. Deleting it loses deduplication history. Changing the calendar path, timing settings, room, or token requires restoring the original configuration or deliberately choosing separate state; separate state may resend upcoming events. History is capped at 10,000 UIDs, 10,000 reminder records, and 8 MiB. At capacity the starter stops adding records; migration or archival is manual, and pending records must not be discarded.

A local lock prevents overlapping runs. After a crash, confirm no process is using the state directory, inspect its records, then remove only `.calendar/run.lock/` if it remains. Do not remove `state.json` to clear a lock.

For other workflows, see [job progress](https://github.com/pingroom/starter-job-progress), [daily digests](https://github.com/pingroom/starter-daily-digest), and [human review](https://github.com/pingroom/starter-human-review).

MIT-licensed starter. The pinned `ical.js` dependency has its own MPL-2.0 license.
