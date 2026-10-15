import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const connectionHome = (env = process.env) => env.PINGROOM_HOME || join(projectRoot, '.pingroom');

export function loadEnvironment() {
  try { loadEnvFile(join(projectRoot, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load .env.'); }
}

export async function loadConfig() {
  let value;
  try { value = JSON.parse(await readFile(join(projectRoot, 'config.json'), 'utf8')); }
  catch { throw new Error('Copy config.example.json to config.json and set your calendar export path.'); }
  if (!value || Array.isArray(value) || Object.keys(value).some((key) => !['calendarFile', 'stateDirectory', 'leadMinutes', 'snapshotMaxAgeMinutes'].includes(key))
    || typeof value.calendarFile !== 'string' || !value.calendarFile.trim() || typeof value.stateDirectory !== 'string' || !value.stateDirectory.trim()
    || !Number.isInteger(value.leadMinutes) || value.leadMinutes < 1 || value.leadMinutes > 1440
    || !Number.isInteger(value.snapshotMaxAgeMinutes) || value.snapshotMaxAgeMinutes < 1 || value.snapshotMaxAgeMinutes > 1440) {
    throw new Error('Config needs calendarFile, stateDirectory, and integer leadMinutes/snapshotMaxAgeMinutes between 1 and 1440.');
  }
  return { ...value, calendarFile: resolve(projectRoot, value.calendarFile), stateDirectory: resolve(projectRoot, value.stateDirectory) };
}

export async function loadConnection(env = process.env) {
  const token = env.PINGROOM_TOKEN?.trim();
  const room = env.PINGROOM_ROOM?.trim();
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined || env.CI) {
    if (!token || !room) throw new Error('Set both PINGROOM_TOKEN and PINGROOM_ROOM; environment and saved credentials cannot be mixed.');
    return { token, room: room.toUpperCase(), apiUrl: 'https://api.pingroom.io' };
  }
  let saved;
  try { saved = JSON.parse(await readFile(join(connectionHome(env), 'credentials.json'), 'utf8')); }
  catch { throw new Error('Run npm run connect, or set both PINGROOM_TOKEN and PINGROOM_ROOM.'); }
  if (typeof saved.token !== 'string' || !saved.token.trim() || typeof saved.room?.invite_code !== 'string' || !saved.room.invite_code.trim()) {
    throw new Error('The saved connection needs a token and home room. Run npm run connect and choose a room.');
  }
  if (saved.api_url && saved.api_url !== 'https://api.pingroom.io') throw new Error('This starter requires a production PingRoom connection.');
  return { token: saved.token.trim(), room: saved.room.invite_code.trim().toUpperCase(), apiUrl: 'https://api.pingroom.io' };
}

export function identity(config, connection) {
  return hash(JSON.stringify({ file: config.calendarFile, lead: config.leadMinutes, freshness: config.snapshotMaxAgeMinutes,
    api: connection.apiUrl, room: connection.room, tokenHash: hash(connection.token) }));
}
