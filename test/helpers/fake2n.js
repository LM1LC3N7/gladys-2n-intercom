// -----------------------------------------------------------------------------
// A fake 2N IP intercom on a real loopback HTTPS server (self-signed test
// certificate of test/fixtures), built from the official "2N IP HTTP API"
// manual (answers { success, result } / { success: false, error: { code } },
// /api/system/info, switch, io, call and log functions) and RFC 7616 for
// Digest (checked here by an implementation of its own, not the
// integration's).
//
// Knobs (all live): `auth`, `latency` (path -> ms, '*' for all), `silent`
// (paths that never answer), `drop` (paths received then cut), `status`
// (path -> HTTP status), `code` (path -> 2N error code, with `codeStatus`),
// `body` (path -> raw text), `info`, `caps`, `switches`, `ports`, `inputs`,
// `sessions`, `pullHoldMs`, `nonceEach401`, `cert` (useCert()).
// Records: `requests` [{ path, query, authorized }], `connections`,
// `handshakes` (TLS done), `channels`. `push(event, params)` queues an
// event on every open channel.
// -----------------------------------------------------------------------------

import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

export const USER = 'gladys';
export const PASSWORD = 'S3cret-Pass_9!';
export const SERIAL = '54-0123-4567';
export const SERIAL_ID = '54-0123-4567';

const load = (name) => {
  const read = (ext) =>
    readFileSync(new URL(`../fixtures/${name}.${ext}`, import.meta.url), 'utf8');
  const cert = read('crt');
  return { key: read('key'), cert, fingerprint256: new X509Certificate(cert).fingerprint256 };
};

export const CERTS = { device: load('device'), impostor: load('impostor') };
export const FP = CERTS.device.fingerprint256;

const md5 = (text) => createHash('md5').update(text).digest('hex');

function digestParams(header) {
  const params = {};
  for (const [, key, quoted, plain] of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    params[key] = quoted ?? plain;
  }
  return params;
}

export async function startFake2N(options = {}) {
  const fake = {
    auth: 'digest',
    username: USER,
    password: PASSWORD,
    realm: 'HTTP API',
    nonce: randomBytes(8).toString('hex'),
    info: {
      devType: '2-14-0-0',
      variant: '2N IP Verso',
      variantId: 4,
      customerId: 0,
      serialNumber: SERIAL,
      macAddr: '7C-1E-B3-00-11-22',
      hwVersion: '535v1',
      swVersion: '2.50.0.70.1',
      buildType: 'release',
      firmwarePackage: '',
      deviceName: 'Portail',
    },
    caps: [
      { switch: 1, enabled: true, mode: 'monostable', switchOnDuration: 5, type: 'normal' },
      { switch: 2, enabled: true, mode: 'bistable', type: 'normal' },
      { switch: 3, enabled: false },
      { switch: 4, enabled: false },
    ],
    switches: {
      1: { active: false, locked: false, held: false },
      2: { active: false, locked: false, held: false },
      3: { active: false, locked: false, held: false },
      4: { active: false, locked: false, held: false },
    },
    ports: [
      { port: 'input1', type: 'input' },
      { port: 'relay1', type: 'output' },
    ],
    inputs: { input1: 0, relay1: 0 },
    sessions: [],
    /** A trigger activates the switch (and queues SwitchStateChanged originator api). */
    activateOnTrigger: true,
    /** An empty pull is held this long (ms), at most its timeout. */
    pullHoldMs: 30,
    latency: {},
    silent: new Set(),
    drop: new Set(),
    status: {},
    code: {},
    codeStatus: {},
    body: {},
    requests: [],
    connections: 0,
    handshakes: 0,
    channels: new Map(),
    nextChannel: 1000,
    openSockets: new Set(),
    held: new Set(),
    ...options,
  };

  const checkAuth = (req) => {
    if (fake.auth === 'none') return true;
    const header = req.headers.authorization ?? '';
    if (fake.auth === 'basic') {
      const expected = `Basic ${Buffer.from(`${fake.username}:${fake.password}`).toString('base64')}`;
      return header === expected;
    }
    if (!header.startsWith('Digest ')) return false;
    const p = digestParams(header.slice(7));
    if (p.username !== fake.username || p.nonce !== fake.nonce || p.realm !== fake.realm) {
      return false;
    }
    if (p.uri !== req.url) return false;
    const ha1 = md5(`${fake.username}:${fake.realm}:${fake.password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const expected = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    return p.response === expected;
  };

  const ok = (result) =>
    JSON.stringify(result === undefined ? { success: true } : { success: true, result });
  const error = (code, param) =>
    JSON.stringify({
      success: false,
      error: { code, ...(param ? { param } : {}), description: 'error' },
    });

  fake.push = (event, params) => {
    for (const channel of fake.channels.values()) {
      channel.queue.push({
        id: (fake.nextEvent = (fake.nextEvent ?? 0) + 1),
        utcTime: 1800000000,
        upTime: 100,
        tzShift: 0,
        event,
        params,
      });
      channel.wake?.();
    }
  };

  const pickSwitch = (query, list) => {
    if (query.switch === undefined) return list;
    return list.filter((s) => String(s.switch) === query.switch);
  };

  /** -> text, or a promise of text (a held pull). */
  const answer = (path, query) => {
    switch (path) {
      case '/api/system/info':
        return ok({ ...fake.info });
      case '/api/switch/caps':
        return ok({
          switches: pickSwitch(
            query,
            fake.caps.map((c) => ({ ...c })),
          ),
        });
      case '/api/switch/status':
        return ok({
          switches: pickSwitch(
            query,
            Object.entries(fake.switches).map(([n, s]) => ({ switch: Number(n), ...s })),
          ),
        });
      case '/api/switch/ctrl': {
        const n = Number(query.switch);
        if (!fake.switches[n]) return error(12, 'switch');
        if (query.action !== 'trigger') return error(12, 'action');
        const caps = fake.caps.find((c) => c.switch === n);
        if (!caps?.enabled || fake.switches[n].locked) return error(14);
        fake.triggers = (fake.triggers ?? 0) + 1;
        if (fake.activateOnTrigger) {
          fake.switches[n].active = caps.mode === 'bistable' ? !fake.switches[n].active : true;
          fake.push('SwitchStateChanged', {
            switch: n,
            state: fake.switches[n].active,
            originator: 'api',
          });
        }
        return ok();
      }
      case '/api/io/caps':
        return ok({ ports: fake.ports.map((p) => ({ ...p })) });
      case '/api/io/status':
        return ok({ ports: Object.entries(fake.inputs).map(([port, state]) => ({ port, state })) });
      case '/api/call/status':
        return ok({ sessions: fake.sessions.map((s) => ({ ...s })) });
      case '/api/log/subscribe': {
        const id = fake.nextChannel++;
        fake.channels.set(id, { queue: [], filter: query.filter, duration: query.duration });
        return ok({ id });
      }
      case '/api/log/unsubscribe':
        fake.channels.delete(Number(query.id));
        return ok();
      case '/api/log/pull': {
        const channel = fake.channels.get(Number(query.id));
        if (!channel) return error(12, 'id');
        const take = () => ok({ events: channel.queue.splice(0, 128) });
        if (channel.queue.length) return take();
        const hold = Math.min(fake.pullHoldMs, Number(query.timeout ?? 0) * 1000);
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            channel.wake = undefined;
            resolve(take());
          }, hold);
          channel.wake = () => {
            clearTimeout(timer);
            channel.wake = undefined;
            resolve(take());
          };
        });
      }
      default:
        return undefined;
    }
  };

  const server = createServer({ key: CERTS.device.key, cert: CERTS.device.cert }, (req, res) => {
    req.resume();
    req.on('end', async () => {
      const url = new URL(req.url, 'https://fake');
      const path = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      const authorized = checkAuth(req);
      fake.requests.push({
        method: req.method,
        path,
        query,
        headers: req.headers,
        authorized,
        open: fake.openSockets.size,
      });
      if (fake.silent.has(path)) return; // never answers
      if (fake.drop.has(path)) {
        if (authorized) answer(path, query); // acted on, then cut
        req.socket.destroy();
        return;
      }
      const wait = fake.latency[path] ?? fake.latency['*'] ?? 0;
      if (!authorized) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        // Many Digest servers give a new nonce at every 401 (no stale flag).
        if (fake.nonceEach401) fake.nonce = randomBytes(8).toString('hex');
        const challenge =
          fake.auth === 'basic'
            ? `Basic realm="${fake.realm}"`
            : `Digest realm="${fake.realm}", qop="auth", nonce="${fake.nonce}", algorithm=MD5`;
        res.writeHead(401, { 'WWW-Authenticate': challenge, 'Content-Type': 'application/json' });
        res.end(error(9));
        return;
      }
      if (fake.status[path]) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        res.writeHead(fake.status[path], { 'Content-Type': 'text/html' });
        res.end('error');
        return;
      }
      if (fake.code[path] !== undefined) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        res.writeHead(fake.codeStatus[path] ?? 200, { 'Content-Type': 'application/json' });
        res.end(error(fake.code[path]));
        return;
      }
      // The answer is what the device holds when the request ARRIVES.
      const text = fake.body[path] ?? (await answer(path, query));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (text === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(text);
    });
  });
  server.on('connection', (socket) => {
    fake.connections += 1;
    fake.openSockets.add(socket);
    socket.on('close', () => fake.openSockets.delete(socket));
  });
  server.on('secureConnection', () => {
    fake.handshakes += 1;
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.host = `127.0.0.1:${fake.port}`;
  /** Presents another certificate from now on. */
  fake.useCert = (cert) => server.setSecureContext({ key: cert.key, cert: cert.cert });
  fake.count = (path) => fake.requests.filter((r) => r.path === path && r.authorized).length;
  fake.close = () =>
    new Promise((resolve) => {
      for (const channel of fake.channels.values()) channel.wake?.();
      for (const socket of fake.openSockets) socket.destroy();
      server.close(() => resolve());
    });
  return fake;
}
