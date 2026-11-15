// -----------------------------------------------------------------------------
// The pure parts (configuration, API answers, devices) and the HTTPS client
// (pin, Digest, bounds) against the fake intercom on loopback.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import {
  PATHS,
  accessEvent,
  callEvent,
  kindOfCode,
  normalizeSerial,
  parseAnswer,
  parseEvents,
  parseInfo,
  parseIoCaps,
  parseIoStatus,
  parseRinging,
  parseSwitchCaps,
  parseSwitchStatus,
  switchEvent,
} from '../src/api.js';
import { normalizeConfig, parseFingerprint, parseHost } from '../src/config.js';
import { LIMITS } from '../src/constants.js';
import { buildDevice, parseFeatureId } from '../src/devices.js';
import { digestHeader, readFingerprint, request } from '../src/http.js';
import { CERTS, FP, PASSWORD, USER, startFake2N } from './helpers/fake2n.js';

const answer = (body, status = 200) => ({ status, text: JSON.stringify(body) });
const fakeGladys = {
  externalId: (rest) => `ext:2n-intercom:${rest}`,
  externalIds: (type, id) => ({
    device: `ext:2n-intercom:${type}:${id}`,
    feature: (key) => `ext:2n-intercom:${type}:${id}:${key}`,
  }),
};

test('configuration: addresses (port 443 by default), fingerprints, bounds, credentials', () => {
  assert.deepEqual(parseHost('192.168.1.50'), {
    address: '192.168.1.50',
    port: 443,
    key: '192.168.1.50',
  });
  assert.equal(parseHost('192.168.1.50:8443').key, '192.168.1.50:8443');
  for (const bad of [
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    'a b',
    'x:0',
    'x:70000',
    'u@h',
    '1.2.3',
  ]) {
    assert.equal(parseHost(bad), undefined, bad);
  }
  const fp = FP.replaceAll(':', '').toLowerCase();
  assert.equal(parseFingerprint(fp), FP);
  assert.equal(parseFingerprint(`SHA256:${FP}`), FP);
  assert.equal(parseFingerprint('AB:CD'), undefined);
  const c = normalizeConfig({
    hosts: '10.0.0.2, bad host, 10.0.0.2, 10.0.0.3:8443',
    fingerprints: `${fp}, nope`,
    username: 'u',
    password: 'p',
    poll_interval: 1,
  });
  assert.deepEqual(
    c.hosts.map((h) => h.key),
    ['10.0.0.2', '10.0.0.3:8443'],
  );
  assert.equal(c.invalid, 1);
  assert.deepEqual(c.fingerprints, [FP]);
  assert.equal(c.badFingerprints, 1);
  assert.equal(c.pollMs, 5000);
  assert.equal(c.allowOpen, false);
  assert.equal(normalizeConfig({ hosts: '10.0.0.2', username: 'u' }).problem, 'credentialsMissing');
  assert.equal(normalizeConfig({ hosts: '10.0.0.2', password: 'p' }).problem, 'credentialsMissing');
  assert.equal(normalizeConfig({ hosts: '10.0.0.2', auth: 'none' }).problem, undefined);
  assert.equal(normalizeConfig({ hosts: '10.0.0.2', auth: 'none', password: 'p' }).password, '');
  assert.equal(normalizeConfig({ hosts: 'x y' }).problem, 'hostsInvalid');
  assert.equal(normalizeConfig({}).problem, 'noHost');
  assert.equal(
    normalizeConfig({ hosts: '10.0.0.2', auth: 'none', allow_open: 'true' }).allowOpen,
    true,
  );
  assert.equal(
    normalizeConfig({ hosts: '10.0.0.2', username: 'a:b', password: 'p' }).problem,
    'credentialsMissing',
  );
  assert.equal(
    normalizeConfig({ hosts: '10.0.0.2', username: 'a', password: 'p\nq' }).problem,
    'credentialsMissing',
  );
});

test('answers: the envelope, the error codes, never a success without `success: true`', () => {
  assert.deepEqual(parseAnswer(answer({ success: true, result: { a: 1 } })), { a: 1 });
  assert.deepEqual(parseAnswer(answer({ success: true })), {});
  const kind = (a) => {
    try {
      parseAnswer(a);
      return 'ok';
    } catch (err) {
      return err.kind;
    }
  };
  assert.equal(kind(answer({ success: false, error: { code: 10 } }, 401)), 'privilege');
  assert.equal(kind(answer({ success: false, error: { code: 4 } })), 'disabled');
  assert.equal(kind(answer({ success: false, error: { code: 14 } })), 'device');
  assert.equal(kind(answer({ success: false, error: { code: 12, param: 'id' } })), 'answer');
  assert.equal(kind(answer({ success: false })), 'answer');
  assert.equal(kind(answer({ result: {} })), 'answer');
  assert.equal(kind(answer({ success: 'true', result: {} })), 'answer');
  assert.equal(kind({ status: 200, text: '<html>' }), 'answer');
  assert.equal(kind({ status: 404, text: '' }), 'unsupported');
  assert.equal(kind({ status: 403, text: '' }), 'privilege');
  assert.equal(kind({ status: 503, text: '' }), 'device');
  assert.equal(kind(answer({ success: true, result: {} }, 202)), 'answer');
  assert.deepEqual([1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19].map(kindOfCode), [
    'unsupported',
    'unsupported',
    'unsupported',
    'disabled',
    'device',
    'method',
    'answer',
    'privilege',
    'answer',
    'answer',
    'answer',
    'device',
    'device',
    'answer',
    'device',
    'device',
  ]);
  // No prototype pollution from an answer.
  parseAnswer({ status: 200, text: '{"success":true,"result":{"__proto__":{"x":1}}}' });
  assert.equal({}.x, undefined);
});

test('identity: the serial number, cleaned; unreadable is refused, never another device', () => {
  const info = parseInfo({
    serialNumber: ' 54-0123-4567 ',
    variant: '2N IP Verso\u0007',
    swVersion: '2.50',
    deviceName: 'A'.repeat(200),
  });
  assert.equal(info.serial, '54-0123-4567');
  assert.equal(info.model, '2N IP Verso');
  assert.equal(info.name.length, LIMITS.text);
  for (const bad of [
    undefined,
    '',
    'ab',
    '00-0000-0000',
    '54.01',
    'a:b',
    '../x',
    'x'.repeat(41),
    12,
  ]) {
    assert.equal(normalizeSerial(bad), undefined, String(bad));
  }
  assert.throws(() => parseInfo({ serialNumber: '' }), { kind: 'answer' });
});

test('switches, inputs, calls: strict values, unknown is unknown', () => {
  const caps = parseSwitchCaps({
    switches: [
      { switch: 1, enabled: true, mode: 'monostable', switchOnDuration: 5, type: 'security' },
      { switch: 2, enabled: 'true', mode: 'other', switchOnDuration: '5' },
      { switch: 5, enabled: true },
      { switch: 1.5, enabled: true },
    ],
  });
  assert.deepEqual([...caps.keys()], [1, 2]);
  assert.deepEqual(caps.get(1), {
    enabled: true,
    mode: 'monostable',
    duration: 5,
    type: 'security',
  });
  assert.deepEqual(caps.get(2), {
    enabled: false,
    mode: undefined,
    duration: undefined,
    type: 'normal',
  });
  const status = parseSwitchStatus({ switches: [{ switch: 1, active: 'true', locked: false }] });
  assert.deepEqual(status.get(1), { active: undefined, locked: false, held: undefined });
  assert.deepEqual(
    parseIoCaps({
      ports: [
        { port: 'input1', type: 'input' },
        { port: 'relay1', type: 'output' },
        { port: '../x', type: 'input' },
        { port: 'input1', type: 'input' },
      ],
    }),
    ['input1'],
  );
  const io = parseIoStatus({
    ports: [
      { port: 'input1', state: 1 },
      { port: 'input2', state: '' },
      { port: 'input3', state: 2 },
      { port: 'input4', state: null },
    ],
  });
  assert.deepEqual([...io], [['input1', 1]]);
  assert.equal(parseRinging({ sessions: [] }), false);
  assert.equal(parseRinging({ sessions: [{ direction: 'outgoing', state: 'ringing' }] }), true);
  assert.equal(parseRinging([{ direction: 'outgoing', state: 'connecting' }]), true);
  assert.equal(parseRinging({ sessions: [{ direction: 'incoming', state: 'ringing' }] }), false);
  assert.equal(parseRinging({ sessions: [{ direction: 'outgoing', state: 'connected' }] }), false);
  assert.throws(() => parseRinging({}), { kind: 'answer' });
});

test('events: the known ones only, bounded, no code nor card number kept', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    id: i,
    event: 'InputChanged',
    params: { port: 'input1', state: i % 2 === 0 },
  }));
  const { events, dropped } = parseEvents({
    events: [{ event: 'CodeEntered', params: { code: '1234' } }, ...many],
  });
  assert.equal(events.length, LIMITS.eventsPerPull);
  assert.equal(dropped, 255 - 1 - LIMITS.eventsPerPull + 1);
  assert.ok(events.every((e) => e.event === 'InputChanged'));
  assert.throws(() => parseEvents({}), { kind: 'answer' });
  assert.deepEqual(switchEvent({ switch: 2, state: true, originator: 'evil\n' }), {
    n: 2,
    active: true,
    originator: null,
  });
  assert.equal(switchEvent({ switch: 2, state: 'true' }), undefined);
  assert.equal(callEvent({ direction: 'outgoing', state: 'x' }), undefined);
  assert.deepEqual(accessEvent({ ap: '1', name: 'Bob', uuid: 'u', code: '1' }, true), {
    user: 'Bob',
    direction: 'exit',
    reason: null,
  });
});

test('paths: the subscription asks for the known events, the trigger for one switch', () => {
  assert.match(PATHS.subscribe(), /^\/api\/log\/subscribe\?include=new&filter=CallStateChanged,/);
  assert.match(PATHS.subscribe(), /duration=60$/);
  assert.equal(PATHS.trigger(2), '/api/switch/ctrl?switch=2&action=trigger');
  assert.equal(PATHS.pull(7), '/api/log/pull?id=7&timeout=20');
});

test('devices: ids, read-only states, a push button per switch, never a switch', () => {
  const device = buildDevice(
    fakeGladys,
    {
      serial: '54-0123-4567',
      model: '2N IP Force',
      firmware: '',
      name: '',
      host: 'h',
      switches: [3, 1],
      inputs: ['input2'],
    },
    'en',
    {
      name: 'Gate',
      features: [{ external_id: 'ext:2n-intercom:2n:54-0123-4567:switch-4:open' }],
    },
  );
  assert.equal(device.name, 'Gate');
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').slice(-2).join(':')),
    [
      'call:ring',
      'switch-1:state',
      'switch-1:open',
      'switch-3:state',
      'switch-3:open',
      'switch-4:state',
      'switch-4:open',
      'input-input2:state',
    ],
  );
  for (const f of device.features) {
    assert.notEqual(f.category, 'switch');
    assert.equal(f.read_only, f.category !== 'button');
  }
  assert.deepEqual(parseFeatureId(fakeGladys, 'ext:2n-intercom:2n:54-0123-4567:switch-1:open'), {
    serial: '54-0123-4567',
    kind: 'open',
    n: 1,
  });
  assert.equal(
    parseFeatureId(fakeGladys, 'ext:2n-intercom:2n:54-0123-4567:switch-9:open'),
    undefined,
  );
  assert.equal(parseFeatureId(fakeGladys, 'ext:other:2n:54-0123-4567:switch-1:open'), undefined);
});

test('Digest: the header of RFC 7616 (MD5, qop auth)', () => {
  const header = digestHeader(
    { username: 'Mufasa', password: 'Circle of Life' },
    {
      realm: 'http-auth@example.org',
      nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
      qop: 'auth',
      algorithm: 'MD5',
      opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
    },
    'GET',
    '/dir/index.html',
    1,
    'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
  );
  assert.match(header, /response="8ca523f5e9506fed4657c9700eebdbec"/);
  assert.equal(
    digestHeader(
      { username: 'a', password: 'b' },
      { nonce: 'n', qop: 'auth-int' },
      'GET',
      '/',
      1,
      'c',
    ),
    undefined,
  );
});

const host = (fake) => ({ address: '127.0.0.1', port: fake.port, key: fake.host });
const auth = { mode: 'digest', username: USER, password: PASSWORD };

test('HTTPS: the pinned certificate only; another one or none: nothing is written', async (t) => {
  const fake = await startFake2N();
  t.after(() => fake.close());
  assert.equal(await readFingerprint(host(fake)), FP);
  const ok = await request({
    host: host(fake),
    pins: [FP],
    path: '/api/system/info',
    auth,
    timeout: 3000,
  });
  assert.equal(ok.status, 200);
  const before = fake.requests.length;
  await assert.rejects(
    request({
      host: host(fake),
      pins: [CERTS.impostor.fingerprint256],
      path: '/api/system/info',
      auth,
      timeout: 3000,
    }),
    (err) => err.kind === 'pin' && err.fingerprint === FP && err.sent === false,
  );
  await assert.rejects(
    request({ host: host(fake), pins: [], path: '/api/system/info', auth, timeout: 3000 }),
    {
      kind: 'nopin',
    },
  );
  fake.useCert(CERTS.impostor);
  await assert.rejects(
    request({
      host: host(fake),
      pins: [FP],
      path: '/api/switch/ctrl?switch=1&action=trigger',
      auth,
      timeout: 3000,
    }),
    { kind: 'pin' },
  );
  assert.equal(fake.requests.length, before);
});

test('HTTPS: an impostor that writes a forged answer right after the handshake gets nothing', async (t) => {
  let received = 0;
  const server = createServer({ key: CERTS.impostor.key, cert: CERTS.impostor.cert });
  server.on('secureConnection', (socket) => {
    socket.on('data', (d) => (received += d.length));
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 32\r\n\r\n{"success":true,"result":{"a":1}}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const target = { address: '127.0.0.1', port: server.address().port, key: 'x' };
  await assert.rejects(
    request({
      host: target,
      pins: [FP],
      path: '/api/system/info',
      auth: { mode: 'basic', username: 'u', password: PASSWORD },
      timeout: 3000,
    }),
    { kind: 'pin' },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received, 0);
});

test('HTTPS: Digest answered once, a wrong password refused, error 10 with 401 is an answer', async (t) => {
  const fake = await startFake2N();
  t.after(() => fake.close());
  const session = {};
  await request({
    host: host(fake),
    pins: [FP],
    path: '/api/system/info',
    auth,
    session,
    timeout: 3000,
  });
  const n = fake.requests.length;
  await request({
    host: host(fake),
    pins: [FP],
    path: '/api/switch/status',
    auth,
    session,
    timeout: 3000,
  });
  assert.equal(fake.requests.length, n + 1, 'the challenge is reused');
  await assert.rejects(
    request({
      host: host(fake),
      pins: [FP],
      path: '/api/system/info',
      auth: { ...auth, password: 'x' },
      timeout: 3000,
    }),
    { kind: 'refused', sent: false },
  );
  fake.code['/api/io/status'] = 10;
  fake.codeStatus['/api/io/status'] = 401;
  const denied = await request({
    host: host(fake),
    pins: [FP],
    path: '/api/io/status',
    auth,
    session,
    timeout: 3000,
  });
  assert.throws(() => parseAnswer(denied), { kind: 'privilege' });
  fake.auth = 'basic';
  await assert.rejects(
    request({
      host: host(fake),
      pins: [FP],
      path: '/api/system/info',
      auth,
      session: {},
      timeout: 3000,
    }),
    { kind: 'basic-only' },
  );
  assert.ok(fake.requests.every((r) => !String(r.headers.authorization ?? '').startsWith('Basic')));
});

test('HTTPS: an answer too large is cut, with or without a declared length; a silent one times out', async (t) => {
  const fake = await startFake2N({ auth: 'none' });
  t.after(() => fake.close());
  fake.body['/api/system/info'] = 'x'.repeat(LIMITS.maxBody + 10);
  await assert.rejects(
    request({ host: host(fake), pins: [FP], path: '/api/system/info', timeout: 3000 }),
    { kind: 'answer' },
  );
  const server = createServer({ key: CERTS.device.key, cert: CERTS.device.cert }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const chunk = 'y'.repeat(16 * 1024);
    let sent = 0;
    const push = () => {
      while (sent < LIMITS.maxBody * 4 && res.write(chunk)) sent += chunk.length;
      if (sent < LIMITS.maxBody * 4) res.once('drain', push);
      else res.end();
    };
    push();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(
    request({
      host: { address: '127.0.0.1', port: server.address().port },
      pins: [FP],
      path: '/x',
      timeout: 3000,
    }),
    { kind: 'answer' },
  );
  fake.silent.add('/api/switch/status');
  const started = Date.now();
  await assert.rejects(
    request({ host: host(fake), pins: [FP], path: '/api/switch/status', timeout: 300 }),
    (err) => err.kind === 'timeout' && err.sent === true,
  );
  assert.ok(Date.now() - started < 2000);
});
