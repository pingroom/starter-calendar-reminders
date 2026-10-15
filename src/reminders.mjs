import { hash, identity } from './config.mjs';
import { INPUT_LIMIT, parseCalendar, reminderFor } from './calendar.mjs';
import { readBounded, readState, withLock, writeState } from './storage.mjs';
import { sendReminder, validId } from './cli.mjs';

const HASH = /^[a-f0-9]{64}$/;
const HISTORY_LIMIT = 10000;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function validateState(state) {
  const bad = () => { throw new Error('Invalid state; preserve it and restore a trusted backup.'); };
  if (!isObject(state) || state.version !== 1 || !HASH.test(state.identity) || !isObject(state.events) || !isObject(state.reminders)
    || Object.keys(state.events).length > HISTORY_LIMIT || Object.keys(state.reminders).length > HISTORY_LIMIT) bad();
  for (const [id, event] of Object.entries(state.events)) {
    if (!HASH.test(id) || !isObject(event) || !Number.isInteger(event.sequence) || event.sequence < 0 || !isDate(event.stamp)
      || !HASH.test(event.fingerprint) || typeof event.present !== 'boolean') bad();
  }
  for (const [id, receipt] of Object.entries(state.reminders)) {
    if (!HASH.test(id) || !isObject(receipt) || !HASH.test(receipt.uidHash) || !Object.hasOwn(state.events, receipt.uidHash)
      || !isDate(receipt.start) || !isDate(receipt.attemptedAt) || id !== hash(`${receipt.uidHash}\n${receipt.start}`)
      || !['sending', 'sent', 'confirmed', 'abandoned'].includes(receipt.status)
      || (receipt.status === 'sent' && !validId(receipt.notificationId))) bad();
  }
  return state;
}

function reconcile(state, events) {
  for (const event of events) {
    const previous = state.events[event.uidHash];
    if (previous) {
      const sameRevision = event.sequence === previous.sequence && event.stamp === previous.stamp;
      if (event.sequence < previous.sequence || event.stamp < previous.stamp
        || (sameRevision && (event.fingerprint !== previous.fingerprint || !previous.present))) {
        throw new Error('Calendar contains an older or conflicting revision. Changed or reintroduced events need a newer DTSTAMP or SEQUENCE, with neither going backwards.');
      }
    }
  }
  const allIds = new Set([...Object.keys(state.events), ...events.map((event) => event.uidHash)]);
  if (allIds.size > HISTORY_LIMIT) throw new Error('Event history reached 10000 UIDs; preserve state and archive this calendar before starting a new one.');
  for (const previous of Object.values(state.events)) previous.present = false;
  for (const event of events) state.events[event.uidHash] = {
    sequence: event.sequence, stamp: event.stamp, fingerprint: event.fingerprint, present: true,
  };
}

async function snapshot(config, now) {
  const { buffer, mtimeMs } = await readBounded(config.calendarFile, INPUT_LIMIT);
  if (now - mtimeMs > config.snapshotMaxAgeMinutes * 60000 || mtimeMs - now > 60000) {
    throw new Error('Calendar export is stale or dated in the future. Publish a fresh complete snapshot before running.');
  }
  return { digest: hash(buffer), events: parseCalendar(buffer) };
}

export async function runReminders(config, connection, { now = Date.now, send = sendReminder } = {}) {
  return withLock(config.stateDirectory, async () => {
    const original = await snapshot(config, now());
    const state = validateState(await readState(config.stateDirectory) ?? { version: 1, identity: identity(config, connection), events: {}, reminders: {} });
    if (state.identity !== identity(config, connection)) throw new Error('Calendar path, settings, or PingRoom destination changed. Restore the original settings or use a separate state directory intentionally.');
    reconcile(state, original.events);
    await writeState(config.stateDirectory, state);
    let sent = 0;
    const events = original.events.sort((a, b) => a.start.localeCompare(b.start) || a.uidHash.localeCompare(b.uidHash));
    for (const event of events) {
      const reminder = reminderFor(event);
      if (event.status === 'CANCELLED' || state.reminders[reminder.id]) continue;
      const currentTime = now();
      const delta = Date.parse(event.start) - currentTime;
      if (delta <= 0 || delta > config.leadMinutes * 60000) continue;
      if (sent >= 20) break;
      const current = await snapshot(config, currentTime);
      if (current.digest !== original.digest) throw new Error('Snapshot changed before delivery; rerun with the current complete export.');
      const checkedAt = now();
      if (Date.parse(event.start) <= checkedAt || Date.parse(event.start) - checkedAt > config.leadMinutes * 60000) continue;
      if (Object.keys(state.reminders).length >= HISTORY_LIMIT) throw new Error('Reminder history reached 10000 records; no more sends will be attempted.');
      state.reminders[reminder.id] = { status: 'sending', uidHash: event.uidHash, start: event.start, title: reminder.title, attemptedAt: new Date(checkedAt).toISOString() };
      // The durable record precedes the external effect. An interrupted attempt is never retried automatically.
      await writeState(config.stateDirectory, state);
      let result;
      try {
        result = await send(reminder, connection);
        if (!validId(result?.notificationId)) throw new Error('No valid notification ID.');
      } catch {
        throw new Error(`Delivery is unconfirmed for ${reminder.id}. Inspect the room, then use npm run resolve; automatic retries are disabled.`);
      }
      state.reminders[reminder.id] = { ...state.reminders[reminder.id], status: 'sent', notificationId: result.notificationId };
      await writeState(config.stateDirectory, state);
      sent += 1;
    }
    return { sent, unresolved: Object.entries(state.reminders).filter(([, receipt]) => receipt.status === 'sending').map(([id]) => id) };
  });
}

export async function resolveReminder(config, id, resolution) {
  if (!HASH.test(id) || !['confirmed', 'abandoned'].includes(resolution)) throw new Error('Use npm run resolve -- <64-character reminder ID> confirmed|abandoned.');
  return withLock(config.stateDirectory, async () => {
    const state = validateState(await readState(config.stateDirectory));
    if (state.reminders[id]?.status !== 'sending') throw new Error('Only an unresolved sending record can be resolved.');
    state.reminders[id] = { ...state.reminders[id], status: resolution, resolvedAt: new Date().toISOString() };
    await writeState(config.stateDirectory, state);
    return { id, status: resolution };
  });
}
