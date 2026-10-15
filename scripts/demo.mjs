import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReminders } from '../src/reminders.mjs';

const directory = await mkdtemp(join(tmpdir(), 'calendar-demo-'));
const now = Date.parse('2030-10-15T09:00:00Z');
const config = { calendarFile: join(directory, 'calendar.ics'), stateDirectory: join(directory, 'state'), leadMinutes: 15, snapshotMaxAgeMinutes: 5 };
try {
  await writeFile(config.calendarFile, await readFile(new URL('../examples/calendar.ics', import.meta.url)));
  await utimes(config.calendarFile, new Date(now), new Date(now));
  let count = 0;
  const options = { now: () => now, send: async (reminder) => {
    count += 1;
    console.log(`Simulated reminder: ${reminder.title} — ${reminder.message}`);
    return { notificationId: '11111111-1111-4111-8111-111111111111' };
  } };
  const connection = { token: 'offline-demo', room: 'offline', apiUrl: 'https://example.invalid' };
  console.log('First run:', await runReminders(config, connection, options));
  console.log('Repeated run:', await runReminders(config, connection, options));
  if (count !== 1) throw new Error('Expected exactly one simulated reminder.');
  console.log('Demo passed: one simulated send; no credentials or network used.');
} finally { await rm(directory, { recursive: true, force: true }); }
