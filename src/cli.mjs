import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const cliPath = createRequire(import.meta.url).resolve('@pingroom/cli/bin/pingroom.js');
export const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);

export async function sendReminder(reminder, connection, { timeoutMs = 15000 } = {}) {
  if ([...reminder.title].length > 40 || [...reminder.message].length > 120) throw new Error('Reminder exceeds PingRoom text limits.');
  const home = await mkdtemp(join(tmpdir(), 'pingroom-calendar-'));
  try {
    const args = [cliPath, 'ping', '--json', '--title', reminder.title, '--message', reminder.message,
      '--data', JSON.stringify({ reminder_id: reminder.id, starts_at: reminder.start })];
    if (reminder.url) args.push('--url', reminder.url, '--button-label', 'Open event');
    if (reminder.geo) {
      args.push('--location', reminder.geo.join(','));
      if (reminder.locationLabel) args.push('--location-label', reminder.locationLabel);
    }
    const { stdout } = await exec(process.execPath, args, {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: 'true', PINGROOM_NO_UPDATE_CHECK: '1',
        PINGROOM_HOME: home, PINGROOM_TOKEN: connection.token, PINGROOM_ROOM: connection.room, PINGROOM_API_URL: connection.apiUrl },
      timeout: timeoutMs, maxBuffer: 65536,
    });
    const response = JSON.parse(stdout);
    const id = response?.notification_id ?? response?.id;
    if (!validId(id) || (response.notification_id !== undefined && response.id !== undefined && response.notification_id !== response.id)) throw new Error('Missing or ambiguous notification ID.');
    return { notificationId: id };
  } catch {
    throw new Error('CLI delivery did not produce a confirmed success; the remote outcome may be unknown.');
  } finally { await rm(home, { recursive: true, force: true }); }
}
