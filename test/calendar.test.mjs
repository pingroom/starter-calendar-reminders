import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCalendar, reminderFor, INPUT_LIMIT } from '../src/calendar.mjs';
import { runReminders, resolveReminder } from '../src/reminders.mjs';
import { readState, withLock } from '../src/storage.mjs';
import { connectionHome, loadConnection, projectRoot } from '../src/config.mjs';

const NOW = Date.parse('2030-10-15T09:00:00Z');
const CONNECTION = { token: 'test-not-a-secret', room: 'test-room', apiUrl: 'https://example.invalid' };
const ID = '11111111-1111-4111-8111-111111111111';
const event = (overrides = {}) => ({ uid: 'event-one', stamp: '20301015T080000Z', start: '20301015T091000Z', sequence: 0, summary: 'Planning', ...overrides });
function ics(events = [event()]) {
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${events.map((e) => `BEGIN:VEVENT\nUID:${e.uid}\nDTSTAMP:${e.stamp}\nDTSTART:${e.start}\nSEQUENCE:${e.sequence}\nSUMMARY:${e.summary}\n${e.extra ?? ''}END:VEVENT\n`).join('')}END:VCALENDAR\n`;
}
const parse = (source) => parseCalendar(Buffer.from(source));

async function fixture(t, events = [event()]) {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { calendarFile: join(directory, 'calendar.ics'), stateDirectory: join(directory, 'state'), leadMinutes: 15, snapshotMaxAgeMinutes: 5 };
  let clock = NOW;
  const publish = async (values) => {
    await writeFile(config.calendarFile, typeof values === 'string' ? values : ics(values));
    await utimes(config.calendarFile, new Date(clock), new Date(clock));
  };
  await publish(events);
  const sent = [];
  const options = { now: () => clock, send: async (reminder) => { sent.push(reminder); return { notificationId: ID }; } };
  return { config, publish, sent, options, now: (value) => { clock = value; }, run: (extra = {}) => runReminders(config, CONNECTION, { ...options, ...extra }) };
}

test('parses folded text, UTC start, URL and GEO; only selected fields enter a reminder', () => {
  const [e] = parse(ics([event({ summary: 'A folded\n title', extra: 'URL:https://example.com/event\nGEO:25.2;55.3\nLOCATION:Room A\\, upstairs\nATTENDEE:mailto:private@example.com\nDESCRIPTION:never forward this\n' })]));
  const reminder = reminderFor(e);
  assert.equal(reminder.title, 'A foldedtitle');
  assert.equal(reminder.start, '2030-10-15T09:10:00.000Z');
  assert.deepEqual(reminder.geo, [25.2, 55.3]);
  assert.equal(reminder.locationLabel, 'Room A, upstairs');
  assert.equal(JSON.stringify(reminder).includes('private'), false);
  assert.equal(JSON.stringify(reminder).includes('never forward'), false);
});

test('rejects invalid calendar forms, ambiguous properties, dates, coordinates, and links', () => {
  const base = ics();
  const invalid = [
    base.replace('VERSION:2.0', 'VERSION:2.0\nMETHOD:REQUEST'),
    base.replace('20301015T091000Z', '20300230T091000Z'),
    base.replace('20301015T091000Z', '20301015T251000Z'),
    base.replace('DTSTART:20301015T091000Z', 'DTSTART;VALUE=DATE:20301015'),
    base.replace('DTSTART:20301015T091000Z', 'DTSTART;TZID=Europe/Paris:20301015T091000'),
    base.replace('20301015T091000Z', '20301015T091000'),
    base.replace('SEQUENCE:0', 'SEQUENCE:1garbage'),
    base.replace('SEQUENCE:0', 'SEQUENCE:-1'),
    base.replace('SUMMARY:Planning', 'SUMMARY:Planning\nSUMMARY:Other'),
    base.replace('DTSTAMP:20301015T080000Z\n', ''),
    ics([event(), event()]),
    ...['RRULE:FREQ=DAILY', 'RDATE:20301016T091000Z', 'EXDATE:20301015T091000Z', 'RECURRENCE-ID:20301015T091000Z',
      'GEO:91;55', 'GEO:25;181', 'GEO:25x;55', 'URL:javascript:alert(1)', 'URL:https://user:password@example.com',
      'BEGIN:VALARM\nACTION:DISPLAY\nEND:VALARM'].map((line) => ics([event({ extra: `${line}\n` })])),
    base.replace('END:VCALENDAR', 'BEGIN:VTIMEZONE\nTZID:UTC\nEND:VTIMEZONE\nEND:VCALENDAR'),
  ];
  for (const source of invalid) assert.throws(() => parse(source), undefined, source);
  assert.throws(() => parseCalendar(Buffer.alloc(INPUT_LIMIT + 1)));
  assert.throws(() => parseCalendar(Buffer.from([0xff])));
  assert.throws(() => parse(ics(Array.from({ length: 1001 }, (_, i) => event({ uid: String(i) })))), /1000/);
});

test('lead window is inclusive at its start; past, current, far future and cancelled events stay quiet', async (t) => {
  const f = await fixture(t, [event({ start: '20301015T091500Z' }), event({ uid: 'past', start: '20301015T085959Z' }),
    event({ uid: 'now', start: '20301015T090000Z' }), event({ uid: 'later', start: '20301015T091501Z' }),
    event({ uid: 'cancelled', extra: 'STATUS:CANCELLED\n' })]);
  assert.equal((await f.run()).sent, 1);
  assert.equal(f.sent.length, 1);
});

test('restart and newer cosmetic revisions do not resend; a new start is a new reminder', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).sent, 1);
  assert.equal((await f.run()).sent, 0);
  await f.publish([event({ sequence: 1, stamp: '20301015T083000Z', summary: 'Renamed meeting' })]);
  assert.equal((await f.run()).sent, 0);
  await f.publish([event({ sequence: 2, stamp: '20301015T084000Z', start: '20301015T091100Z' })]);
  assert.equal((await f.run()).sent, 1);
  assert.equal(f.sent.length, 2);
});

test('cancellation and removal suppress previously unseen reminders; old snapshots cannot resurrect removed events', async (t) => {
  const initial = event({ start: '20301015T093000Z' });
  const f = await fixture(t, [initial]);
  assert.equal((await f.run()).sent, 0);
  f.now(NOW + 20 * 60000);
  await f.publish([{ ...initial, sequence: 1, stamp: '20301015T091000Z', extra: 'STATUS:CANCELLED\n' }]);
  assert.equal((await f.run()).sent, 0);
  await f.publish([]);
  assert.equal((await f.run()).sent, 0);
  await f.publish([{ ...initial, sequence: 1, stamp: '20301015T091000Z', extra: 'STATUS:CANCELLED\n' }]);
  await assert.rejects(f.run(), /older or conflicting/);
  await f.publish([{ ...initial, sequence: 2, stamp: '20301015T091100Z' }]);
  assert.equal((await f.run()).sent, 1);
});

test('changed content with equal revision and all revision rollbacks fail before any send', async (t) => {
  const initial = event({ start: '20301015T093000Z', sequence: 2 });
  const f = await fixture(t, [initial]);
  await f.run();
  for (const changed of [{ ...initial, summary: 'Changed' }, { ...initial, sequence: 1, stamp: '20301015T083000Z' }, { ...initial, sequence: 3, stamp: '20301015T075959Z' }]) {
    await f.publish([event({ uid: 'otherwise-due' }), changed]);
    await assert.rejects(f.run(), /older or conflicting/);
  }
  assert.equal(f.sent.length, 0);
});

test('changed snapshot is checked before the next delivery', async (t) => {
  const f = await fixture(t, [event(), event({ uid: 'second', start: '20301015T091100Z' })]);
  let sent = 0;
  await assert.rejects(f.run({ send: async () => { sent++; await f.publish([]); return { notificationId: ID }; } }), /Snapshot changed/);
  assert.equal(sent, 1);
  assert.equal((await f.run()).sent, 0);
});

test('expired events during a batch are never delivered', async (t) => {
  const f = await fixture(t, [event(), event({ uid: 'second', start: '20301015T091100Z' })]);
  let sent = 0;
  assert.equal((await f.run({ send: async () => {
    sent++; f.now(NOW + 12 * 60000); return { notificationId: ID };
  } })).sent, 1);
  assert.equal(sent, 1);
});

test('uncertain sends persist before invocation, are not retried, and can be confirmed or abandoned', async (t) => {
  for (const resolution of ['confirmed', 'abandoned']) {
    const f = await fixture(t);
    let calls = 0;
    await assert.rejects(f.run({ send: async (reminder) => {
      calls++;
      assert.equal((await readState(f.config.stateDirectory)).reminders[reminder.id].status, 'sending');
      throw new Error('sensitive transport output');
    } }), /Delivery is unconfirmed/);
    const result = await f.run();
    assert.equal(calls, 1);
    assert.equal(f.sent.length, 0);
    assert.equal(result.unresolved.length, 1);
    await resolveReminder(f.config, result.unresolved[0], resolution);
    assert.deepEqual(await f.run(), { sent: 0, unresolved: [] });
    await assert.rejects(resolveReminder(f.config, result.unresolved[0], resolution), /Only an unresolved/);
  }
});

test('missing notification ID is unresolved and never treated as sent', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ send: async () => ({}) }), /unconfirmed/);
  assert.equal((await f.run()).unresolved.length, 1);
  assert.equal(f.sent.length, 0);
});

test('stale snapshots, changed destination, corrupt state and concurrent runs fail closed', async (t) => {
  const f = await fixture(t, []);
  await utimes(f.config.calendarFile, new Date(NOW - 6 * 60000), new Date(NOW - 6 * 60000));
  await assert.rejects(f.run(), /stale/);
  await f.publish([]);
  await withLock(f.config.stateDirectory, () => assert.rejects(f.run(), /Another run/));
  await f.run();
  await assert.rejects(runReminders(f.config, { ...CONNECTION, room: 'other' }, f.options), /destination changed/);
  await writeFile(join(f.config.stateDirectory, 'state.json'), '{"version":1}');
  await assert.rejects(f.run(), /Invalid state/);
});

test('literal null or array state never resets delivery history', async (t) => {
  const f = await fixture(t);
  await f.run();
  for (const value of ['null', '[]', 'false']) {
    await writeFile(join(f.config.stateDirectory, 'state.json'), value);
    await assert.rejects(f.run(), /State cannot be read/);
  }
  assert.equal(f.sent.length, 1);
});

test('environment credentials must be a complete nonblank pair; the default home is project-local', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'calendar-connection-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'credentials.json'), JSON.stringify({ token: 'saved', room: { invite_code: 'saved-room' } }));
  assert.equal(connectionHome({}), join(projectRoot, '.pingroom'));
  assert.equal((await loadConnection({ PINGROOM_HOME: home })).token, 'saved');
  for (const values of [{ PINGROOM_TOKEN: '' }, { PINGROOM_ROOM: '' }, { PINGROOM_TOKEN: '', PINGROOM_ROOM: '' }, { PINGROOM_TOKEN: 'only-token' }, { CI: 'true' }]) {
    await assert.rejects(loadConnection({ PINGROOM_HOME: home, ...values }), /Set both/);
  }
  assert.equal((await loadConnection({ PINGROOM_HOME: home, PINGROOM_TOKEN: 'env', PINGROOM_ROOM: 'env-room' })).room, 'ENV-ROOM');
  assert.equal((await loadConnection({ PINGROOM_HOME: home })).room, 'SAVED-ROOM');
});
