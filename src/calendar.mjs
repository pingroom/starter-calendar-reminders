import ICAL from 'ical.js';
import { hash } from './config.mjs';

export const INPUT_LIMIT = 1024 * 1024;
export const EVENT_LIMIT = 1000;
const trimText = (value) => value.replace(/[\r\n\t]+/g, ' ').trim();
export const clip = (value, length) => [...value].slice(0, length).join('');

function property(component, name, required = false) {
  const all = component.getAllProperties(name);
  if (all.length > 1 || (required && all.length !== 1)) throw new Error(`Each event needs one ${name.toUpperCase()} at most, and required fields must be present.`);
  return all[0];
}

function textValue(component, name, { required = false, limit = 255 } = {}) {
  const p = property(component, name, required);
  if (!p) return null;
  const value = p.getFirstValue();
  if (typeof value !== 'string' || p.getValues().length !== 1 || !value.trim() || [...value].length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid ${name.toUpperCase()} text.`);
  }
  return trimText(value);
}

function utcTime(component, name) {
  const p = property(component, name, true);
  const raw = p.toJSON()[3];
  if (p.type !== 'date-time' || Object.keys(p.toJSON()[1]).length || p.getValues().length !== 1
    || typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw)) throw new Error(`${name.toUpperCase()} must be an explicit UTC date-time ending in Z.`);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== raw.replace('Z', '.000Z')) throw new Error(`Invalid ${name.toUpperCase()} date.`);
  return date.toISOString();
}

export function parseCalendar(buffer) {
  if (buffer.length > INPUT_LIMIT) throw new Error('Calendar exceeds 1 MiB.');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('Calendar must be valid UTF-8.'); }
  // Validate lexical forms before the parser can normalize invalid dates or integers.
  const lines = source.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const componentNames = [];
  for (const line of lines) {
    if (line.length > 8192 || line.includes('\0')) throw new Error('Calendar line exceeds its limit or contains a null byte.');
    // ical.js does not check that an END name matches the component it closes.
    const delimiter = /^(BEGIN|END):(.+)$/i.exec(line);
    if (delimiter) {
      const name = delimiter[2].toLowerCase();
      if (delimiter[1].toLowerCase() === 'begin') componentNames.push(name);
      else if (componentNames.pop() !== name) throw new Error('Calendar component delimiters must have matching BEGIN and END names.');
    }
    if (/^(DTSTART|DTSTAMP)(?:;|:)/i.test(line) && !/^(DTSTART|DTSTAMP):\d{8}T\d{6}Z$/i.test(line)) throw new Error('Only UTC DTSTART and DTSTAMP without parameters are supported.');
    if (/^SEQUENCE(?:;|:)/i.test(line) && !/^SEQUENCE:\d{1,9}$/i.test(line)) throw new Error('SEQUENCE must be a nonnegative integer.');
    if (/^GEO(?:;|:)/i.test(line) && !/^GEO:[+-]?(?:\d+(?:\.\d+)?|\.\d+);[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/i.test(line)) throw new Error('GEO must contain decimal latitude;longitude.');
  }
  if (componentNames.length) throw new Error('Calendar component delimiters must have matching BEGIN and END names.');
  let calendar;
  try { calendar = new ICAL.Component(ICAL.parse(source)); }
  catch { throw new Error('Could not parse the ICS snapshot.'); }
  if (calendar.name !== 'vcalendar' || calendar.getAllProperties('version').length !== 1 || calendar.getFirstPropertyValue('version') !== '2.0'
    || calendar.hasProperty('method')) throw new Error('Use a VERSION:2.0 VCALENDAR snapshot without METHOD.');
  const components = calendar.getAllSubcomponents();
  if (components.length > EVENT_LIMIT) throw new Error('Calendar exceeds 1000 events.');
  const seen = new Set();
  return components.map((component) => {
    if (component.name !== 'vevent' || component.getAllSubcomponents().length || ['rrule', 'rdate', 'exdate', 'exrule', 'recurrence-id'].some((name) => component.hasProperty(name))) {
      throw new Error('Only single VEVENTs are supported; remove recurrence, timezones, alarms, and other components.');
    }
    const uid = textValue(component, 'uid', { required: true, limit: 255 });
    if (seen.has(uid)) throw new Error('Every UID must be unique in a snapshot.');
    seen.add(uid);
    const start = utcTime(component, 'dtstart');
    const stamp = utcTime(component, 'dtstamp');
    const summary = textValue(component, 'summary', { required: true, limit: 200 });
    const sequenceProperty = property(component, 'sequence');
    const sequence = sequenceProperty?.getFirstValue() ?? 0;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999999999) throw new Error('Invalid SEQUENCE.');
    const status = textValue(component, 'status') ?? 'CONFIRMED';
    if (!['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(status)) throw new Error('Unsupported event STATUS.');
    const url = textValue(component, 'url', { limit: 2048 });
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error('Event URL is invalid.'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || /\s/.test(url)) throw new Error('Event URL needs HTTP(S) without credentials or whitespace.');
    }
    const location = textValue(component, 'location', { limit: 255 });
    const geo = property(component, 'geo')?.getFirstValue() ?? null;
    if (geo && (!Array.isArray(geo) || geo.length !== 2 || !geo.every(Number.isFinite) || Math.abs(geo[0]) > 90 || Math.abs(geo[1]) > 180)) throw new Error('GEO coordinates are out of range.');
    const event = { uidHash: hash(uid), start, stamp, sequence, summary, status, url, location, geo };
    return { ...event, fingerprint: hash(JSON.stringify({ start, summary, status, url, location, geo })) };
  });
}

export function reminderFor(event) {
  return {
    id: hash(`${event.uidHash}\n${event.start}`), uidHash: event.uidHash, start: event.start,
    title: clip(event.summary, 40),
    message: clip(`Starts ${event.start.replace('.000Z', ' UTC')}${event.location ? ` · ${event.location}` : ''}`, 120),
    url: event.url, geo: event.geo, locationLabel: event.location ? clip(event.location, 100) : null,
  };
}
