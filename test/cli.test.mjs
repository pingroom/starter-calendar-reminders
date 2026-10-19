import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendReminder } from '../src/cli.mjs';
import { parseCalendar, reminderFor } from '../src/calendar.mjs';
import { runReminders } from '../src/reminders.mjs';

const NOTIFICATION_ID = '12345678-1234-4123-8123-123456789abc';
const NOW = Date.parse('2030-10-15T09:00:00Z');
const example = await readFile(new URL('../examples/calendar.ics', import.meta.url));
const reminder = reminderFor(parseCalendar(example)[0]);

async function server(t, handler) {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}

test('real CLI 0.12.0 sends one reminder with link and location; persisted replay sends zero', { timeout: 15000 }, async (t) => {
  const requests = [];
  const apiUrl = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    // The agent route answers 201 with the created notification row; its `id` is the notification ID.
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: NOTIFICATION_ID, type: 'sent' }));
  });
  const directory = await mkdtemp(join(tmpdir(), 'calendar-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { calendarFile: join(directory, 'calendar.ics'), stateDirectory: join(directory, 'state'), leadMinutes: 15, snapshotMaxAgeMinutes: 5 };
  await writeFile(config.calendarFile, example);
  await utimes(config.calendarFile, new Date(NOW), new Date(NOW));
  const previous = process.env.PINGROOM_WEBHOOK_URL;
  process.env.PINGROOM_WEBHOOK_URL = `${apiUrl}/ambient-webhook-must-not-be-used`;
  t.after(() => { if (previous === undefined) delete process.env.PINGROOM_WEBHOOK_URL; else process.env.PINGROOM_WEBHOOK_URL = previous; });
  const connection = { apiUrl, token: 'fixture-token-only', room: 'ROOM42' };
  const options = { now: () => NOW, send: (value, target) => sendReminder(value, target, { timeoutMs: 5000 }) };
  assert.equal((await runReminders(config, connection, options)).sent, 1);
  assert.equal((await runReminders(config, connection, options)).sent, 0);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/agent/rooms/ROOM42/notifications');
  assert.equal(request.auth, 'Bearer fixture-token-only');
  assert.equal(request.body.title, 'Planning meeting');
  assert.equal(request.body.data.url, 'https://example.com/meetings/planning');
  assert.equal(request.body.data.button_label, 'Open event');
  assert.deepEqual(request.body.data.location, { latitude: 25.2048, longitude: 55.2708, label: 'Meeting room' });
  assert.equal(request.body.data.reminder_id, reminder.id);
  const stateText = await readFile(join(config.stateDirectory, 'state.json'), 'utf8');
  assert.equal(stateText.includes('fixture-token-only'), false);
  assert.equal(JSON.parse(stateText).reminders[reminder.id].notificationId, NOTIFICATION_ID);
});

test('real CLI errors and malformed success are sanitized; a hanging request has a bounded deadline', { timeout: 20000 }, async (t) => {
  let mode = 'error';
  let hits = 0;
  let arrived;
  const requestArrived = new Promise((resolve) => { arrived = resolve; });
  const apiUrl = await server(t, (req, res) => {
    hits++;
    req.resume();
    if (mode === 'hang') { arrived(); return; }
    res.writeHead(mode === 'error' ? 403 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mode === 'error' ? { error: 'fixture-token-sensitive-details' } : { success: true }));
  });
  const connection = { apiUrl, token: 'fixture-token', room: 'TEST' };
  for (const value of ['error', 'malformed']) {
    mode = value;
    await assert.rejects(sendReminder(reminder, connection, { timeoutMs: 5000 }), (error) => {
      assert.equal(error.message.includes('fixture-token'), false);
      return /remote outcome may be unknown/.test(error.message);
    });
  }
  assert.equal(hits, 2);
  mode = 'hang';
  const start = Date.now();
  const rejection = assert.rejects(sendReminder(reminder, connection, { timeoutMs: 3000 }), /remote outcome may be unknown/);
  await Promise.all([requestArrived, rejection]);
  assert.equal(hits, 3);
  assert.ok(Date.now() - start >= 2800, 'The request reached the server and was stopped at the configured deadline.');
});
