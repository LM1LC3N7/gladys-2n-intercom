// -----------------------------------------------------------------------------
// The HTTP API of the 2N IP intercoms, from the official manual "2N IP HTTP
// API" (wiki.2n.com/hip/hapi, version 3.3 for firmware 2.50):
//   GET /api/system/info            identity: serialNumber, macAddr, variant, swVersion
//   GET /api/switch/caps            switches: { switch, enabled, mode, switchOnDuration, type }
//   GET /api/switch/status          switches: { switch, active, locked, held }
//   GET /api/switch/ctrl?switch=n&action=trigger    an opening (monostable switch only)
//   GET /api/io/caps                ports: { port, type: input|output }
//   GET /api/io/status              ports: { port, state }
//   GET /api/call/status            sessions: { session, direction, state }
//   GET /api/log/subscribe?filter=...&duration=s    event channel -> { id }
//   GET /api/log/pull?id=..&timeout=s               events: { id, upTime, event, params }
//   GET /api/log/unsubscribe?id=..
// Every answer is { success, result } or { success: false, error: { code } }
// (manual 2.3), with HTTP 200 (error 9, and sometimes others, with 401).
// Pure functions only: no I/O here.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';
import { IntercomError } from './http.js';
import { isObject, own, safeJson } from './json.js';

/** The events read from the channel (the others are not asked for). */
export const EVENTS = Object.freeze([
  'CallStateChanged',
  'SwitchStateChanged',
  'InputChanged',
  'UserAuthenticated',
  'UserRejected',
]);

export const PATHS = Object.freeze({
  info: '/api/system/info',
  switchCaps: '/api/switch/caps',
  switchStatus: '/api/switch/status',
  switchCapsOf: (n) => `/api/switch/caps?switch=${n}`,
  switchStatusOf: (n) => `/api/switch/status?switch=${n}`,
  trigger: (n) => `/api/switch/ctrl?switch=${n}&action=trigger`,
  ioCaps: '/api/io/caps',
  ioStatus: '/api/io/status',
  call: '/api/call/status',
  subscribe: () =>
    `/api/log/subscribe?include=new&filter=${EVENTS.join(',')}&duration=${TIMINGS.channelSeconds}`,
  pull: (id) => `/api/log/pull?id=${id}&timeout=${TIMINGS.pullSeconds}`,
  unsubscribe: (id) => `/api/log/unsubscribe?id=${id}`,
});

/** The error kind of a 2N error code (manual 2.3). */
export function kindOfCode(code) {
  if (code === 1 || code === 2 || code === 3) return 'unsupported';
  if (code === 4) return 'disabled';
  if (code === 8) return 'method';
  // Error 9 without a 401 is no refusal of credentials (see http.js).
  if (code === 9) return 'answer';
  if (code === 10) return 'privilege';
  if (code === 11 || code === 12 || code === 13 || code === 17) return 'answer';
  return 'device';
}

/** The `result` of an answer, checked (status and envelope). */
export function parseAnswer({ status, text }) {
  if (status === 403) throw new IntercomError('Forbidden', 'privilege', { sent: true, status });
  if (status === 404) throw new IntercomError('Not found', 'unsupported', { sent: true, status });
  if (status >= 500) throw new IntercomError(`HTTP ${status}`, 'device', { sent: true, status });
  let body;
  try {
    body = safeJson(text);
  } catch {
    throw new IntercomError('Not JSON', 'answer', { sent: true, status });
  }
  const success = own(body, 'success');
  if (success === false) {
    const code = own(own(body, 'error'), 'code');
    const kind = Number.isInteger(code) ? kindOfCode(code) : 'answer';
    throw new IntercomError(`Error ${Number.isInteger(code) ? code : '?'}`, kind, {
      sent: true,
      status,
      code: Number.isInteger(code) ? code : undefined,
    });
  }
  if (success !== true || status !== 200) {
    throw new IntercomError('No envelope', 'answer', { sent: true, status });
  }
  const result = own(body, 'result');
  return result === undefined ? {} : result;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A text of the device, made safe to publish: no control character, bounded. */
export function cleanText(value, max = LIMITS.text) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(CONTROL, ' ').trim().slice(0, max);
}

/**
 * A serial number ("54-0123-4567") -> the device id ("54-0123-4567", lower
 * case), undefined when unusable: 4 to 40 letters, digits and dashes.
 */
export function normalizeSerial(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/.test(text)) return undefined;
  if (/^[0-]+$/.test(text)) return undefined;
  return text;
}

/** /api/system/info -> { serial, model, firmware, name }; throws when the serial is unreadable. */
export function parseInfo(result) {
  const serial = normalizeSerial(own(result, 'serialNumber'));
  if (!serial) throw new IntercomError('No serial number', 'answer', { sent: true });
  return {
    serial,
    model: cleanText(own(result, 'variant')) || '2N IP',
    firmware: cleanText(own(result, 'swVersion')),
    name: cleanText(own(result, 'deviceName')),
  };
}

const switchNumber = (value) =>
  Number.isInteger(value) && value >= 1 && value <= LIMITS.switches ? value : undefined;

const listOf = (result, key) => {
  const list = own(result, key);
  return Array.isArray(list) ? list.slice(0, 64) : [];
};

/**
 * /api/switch/caps -> Map n -> { enabled, mode: 'monostable'|'bistable'|undefined,
 * duration: seconds|undefined, type }. A switch whose number is unusable is dropped.
 */
export function parseSwitchCaps(result) {
  const switches = new Map();
  for (const item of listOf(result, 'switches')) {
    const n = switchNumber(own(item, 'switch'));
    if (n === undefined || switches.has(n)) continue;
    const mode = own(item, 'mode');
    const duration = own(item, 'switchOnDuration');
    switches.set(n, {
      enabled: own(item, 'enabled') === true,
      mode: mode === 'monostable' || mode === 'bistable' ? mode : undefined,
      duration: Number.isInteger(duration) && duration >= 0 ? duration : undefined,
      type: own(item, 'type') === 'security' ? 'security' : 'normal',
    });
  }
  return switches;
}

/** /api/switch/status -> Map n -> { active, locked, held } (booleans, or undefined if unreadable). */
export function parseSwitchStatus(result) {
  const switches = new Map();
  for (const item of listOf(result, 'switches')) {
    const n = switchNumber(own(item, 'switch'));
    if (n === undefined || switches.has(n)) continue;
    const flag = (key) => (typeof own(item, key) === 'boolean' ? own(item, key) : undefined);
    switches.set(n, { active: flag('active'), locked: flag('locked'), held: flag('held') });
  }
  return switches;
}

const PORT = /^[A-Za-z0-9_]{1,32}$/;

/** /api/io/caps -> the names of the inputs, in order (the outputs are not kept). */
export function parseIoCaps(result) {
  const inputs = [];
  for (const item of listOf(result, 'ports')) {
    const port = own(item, 'port');
    if (typeof port !== 'string' || !PORT.test(port) || own(item, 'type') !== 'input') continue;
    if (!inputs.includes(port) && inputs.length < LIMITS.inputs) inputs.push(port);
  }
  return inputs;
}

/** /api/io/status -> Map port -> 0|1 (a state that is not 0 or 1 is unknown: not kept). */
export function parseIoStatus(result) {
  const ports = new Map();
  for (const item of listOf(result, 'ports')) {
    const port = own(item, 'port');
    const state = own(item, 'state');
    if (typeof port !== 'string' || !PORT.test(port) || ports.has(port)) continue;
    if (state === 0 || state === 1) ports.set(port, state);
    else if (state === true || state === false) ports.set(port, state ? 1 : 0);
  }
  return ports;
}

/**
 * Is a visitor ringing? A door intercom calls out when its button is pressed:
 * an outgoing call that is connecting or ringing. /api/call/status -> true |
 * false. The manual shows the sessions as `result.sessions` (a bare list is
 * read too); an unreadable answer throws.
 */
export function parseRinging(result) {
  const list = Array.isArray(result) ? result : own(result, 'sessions');
  if (!Array.isArray(list)) throw new IntercomError('No call list', 'answer', { sent: true });
  return list
    .slice(0, 64)
    .some(
      (s) =>
        own(s, 'direction') === 'outgoing' &&
        (own(s, 'state') === 'ringing' || own(s, 'state') === 'connecting'),
    );
}

/** /api/log/subscribe -> the channel id. */
export function parseChannel(result) {
  const id = own(result, 'id');
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
    throw new IntercomError('No channel id', 'answer', { sent: true });
  }
  return id;
}

/**
 * /api/log/pull -> [{ event, params, upTime }], oldest first, the known
 * events only, at most LIMITS.eventsPerPull (the newest kept), and the
 * count dropped.
 */
export function parseEvents(result) {
  const list = own(result, 'events');
  if (!Array.isArray(list)) throw new IntercomError('No event list', 'answer', { sent: true });
  const events = [];
  for (const item of list.slice(0, 256)) {
    const event = own(item, 'event');
    const params = own(item, 'params');
    if (!EVENTS.includes(event) || !isObject(params)) continue;
    events.push({ event, params, upTime: own(item, 'upTime') });
  }
  const dropped = Math.max(0, events.length - LIMITS.eventsPerPull);
  return { events: events.slice(dropped), dropped };
}

const ORIGINATORS = [
  'profile',
  'api',
  'ap',
  'rex',
  'idt',
  'dtmf',
  'auth',
  'uni',
  'zone',
  'automation',
];

/** SwitchStateChanged params -> { n, active, originator } or undefined. */
export function switchEvent(params) {
  const n = switchNumber(own(params, 'switch'));
  const state = own(params, 'state');
  if (n === undefined || typeof state !== 'boolean') return undefined;
  const originator = own(params, 'originator');
  return { n, active: state, originator: ORIGINATORS.includes(originator) ? originator : null };
}

/** InputChanged params -> { port, state: 0|1 } or undefined. */
export function inputEvent(params) {
  const port = own(params, 'port');
  const state = own(params, 'state');
  if (typeof port !== 'string' || !PORT.test(port) || typeof state !== 'boolean') return undefined;
  return { port, state: state ? 1 : 0 };
}

/** CallStateChanged params -> { session, direction, state } or undefined. */
export function callEvent(params) {
  const direction = own(params, 'direction');
  const state = own(params, 'state');
  const session = own(params, 'session');
  if (direction !== 'incoming' && direction !== 'outgoing') return undefined;
  if (!['connecting', 'ringing', 'connected', 'terminated'].includes(state)) return undefined;
  return { session: Number.isInteger(session) ? session : undefined, direction, state };
}

/** UserAuthenticated / UserRejected params -> scene variables (no code, no card uid). */
export function accessEvent(params, rejected) {
  const reason = own(params, 'reason');
  return {
    user: cleanText(own(params, 'name')) || null,
    direction: own(params, 'ap') === '1' || own(params, 'ap') === 1 ? 'exit' : 'entry',
    ...(rejected ? { reason: /^[A-Za-z]{1,32}$/.test(reason ?? '') ? reason : null } : {}),
  };
}
