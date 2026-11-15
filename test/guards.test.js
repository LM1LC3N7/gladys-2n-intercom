// -----------------------------------------------------------------------------
// One test per guard of the review r1 (refusals, backoffs, /data, the
// activation marks, the event channel, stop, bounds): each fails when its
// guard is removed (scripts/mutants.json).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { request as realRequest } from '../src/http.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { CERTS, FP, PASSWORD, USER, startFake2N } from './helpers/fake2n.js';
import { D, F, press, setup, sleep, until, within } from './helpers/app.js';

const POLL = 10_000;
const said = (answer) => answer.data?.message?.fr ?? String(answer.data);
const triggers = (fake) =>
  fake.requests.filter((r) => r.path === '/api/switch/ctrl' && r.authorized);

async function events(s, condition, what = 'events', steps = 40) {
  for (let i = 0; i < steps; i += 1) {
    if (condition()) return;
    await s.advance(1000);
    await sleep(30);
  }
  assert.ok(condition(), `${what}: not met`);
}

/** The virtual times at which `path` was asked (authorized or not). */
function timesOf(s, path) {
  const at = [];
  const original = s.fake.requests.push.bind(s.fake.requests);
  s.fake.requests.push = (r) => {
    if (r.path === path) at.push(s.clock.now);
    return original(r);
  };
  return at;
}

// --- refusals (R1, R2, R17, R18, M1) -------------------------------------------

test('a 401 on the trigger is reported, never refused credentials (R1)', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.status['/api/switch/ctrl'] = 401;
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /rien envoyé \(refus de l’interphone \(401\)\)/);
  assert.equal(s.session().state, 'ok');
  assert.deepEqual(s.store.data.refused, {});
  assert.equal(s.session().ownOpens.length, 0, 'no mark left when nothing was done');
});

test('error 10 on the identity is no refusal of credentials (R2)', async (t) => {
  const s = await setup(t, {
    fake: { code: { '/api/system/info': 10 }, codeStatus: { '/api/system/info': 401 } },
  });
  await s.step(0);
  await until(() => s.session().state === 'answer');
  assert.deepEqual(s.store.data.refused, {});
});

test('error 9 with HTTP 200 on the identity is no refusal (M1)', async (t) => {
  const s = await setup(t, {
    fake: { code: { '/api/system/info': 9 }, codeStatus: { '/api/system/info': 200 } },
  });
  await s.step(0);
  await until(() => s.session().state === 'answer');
  assert.deepEqual(s.store.data.refused, {});
});

test('a challenge that cannot be answered sends no proof and is no refusal (M1)', async (t) => {
  for (const challenge of [
    'Digest realm="HTTP API", qop="auth-int", nonce="abc"',
    'Digest realm="HTTP API", qop="auth", nonce="abc", algorithm=SHA-512-256',
  ]) {
    const seen = [];
    const server = createServer({ key: CERTS.device.key, cert: CERTS.device.cert }, (req, res) => {
      seen.push(req.headers.authorization ?? null);
      res.writeHead(401, { 'WWW-Authenticate': challenge, 'Content-Type': 'application/json' });
      res.end('{"success":false,"error":{"code":9}}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const host = { address: '127.0.0.1', port: server.address().port, key: 'x' };
    await assert.rejects(
      realRequest({
        host,
        pins: [FP],
        path: '/api/system/info',
        auth: { mode: 'digest', username: 'u', password: 'p' },
        session: {},
        timeout: 3000,
      }),
      { kind: 'method' },
    );
    assert.deepEqual(seen, [null, null]);
  }
});

test('a refused session is not tried again by a reconnection to Gladys (R17)', async (t) => {
  const s = await setup(t, { fake: { password: 'other' } });
  await s.step(0);
  await until(() => s.session().state === 'refused');
  const asked = s.fake.requests.length;
  s.gladys.emit('connected');
  await sleep(50);
  await s.step(0);
  await sleep(50);
  assert.equal(s.session().state, 'refused');
  assert.equal(s.fake.requests.length, asked);
});

test('saving the configuration tries refused credentials once more (R18)', async (t) => {
  const s = await setup(t, { fake: { password: 'other' } });
  await s.step(0);
  await until(() => s.session().state === 'refused');
  const asked = s.fake.requests.length;
  s.fake.password = PASSWORD;
  await s.gladys.fake.configUpdated({ ...s.gladys.fake.config });
  await s.step(0);
  await until(() => s.session().state === 'ok');
  assert.ok(s.fake.requests.length > asked);
  assert.deepEqual(s.store.data.refused, {});
});

// --- Digest nonce (I2) ------------------------------------------------------------

test('a nonce changed with two requests in flight is never a refusal (I2)', async (t) => {
  const fake = await startFake2N();
  t.after(() => fake.close());
  const host = { address: '127.0.0.1', port: fake.port, key: fake.host };
  const session = {};
  const opts = (path) => ({
    host,
    pins: [FP],
    auth: { mode: 'digest', username: USER, password: PASSWORD },
    session,
    path,
    timeout: 3000,
  });
  assert.equal((await realRequest(opts('/api/system/info'))).status, 200);
  fake.nonce = 'rotated0000000001';
  const results = await Promise.allSettled([
    realRequest(opts('/api/switch/status')),
    realRequest(opts('/api/system/info')),
    realRequest(opts('/api/io/status')),
  ]);
  assert.deepEqual(
    results.map((r) => (r.status === 'fulfilled' ? r.value.status : r.reason.kind)),
    [200, 200, 200],
  );
  assert.equal(session.challenge.nonce, 'rotated0000000001');
});

test('a nonce changed while the cycle and the channel read: the session stays up (I2)', async (t) => {
  const s = await setup(t);
  await s.ready();
  await events(s, () => s.session().channel !== undefined, 'channel');
  for (let i = 0; i < 4; i += 1) {
    s.fake.nonce = `rotated${i}`;
    await s.advance(POLL);
    await sleep(100);
  }
  await until(() => !s.session().currentRead);
  assert.equal(s.session().state, 'ok');
  assert.deepEqual(s.store.data.refused, {});
});

test('a refusal never clears the challenge another request installed meanwhile (I2)', async (t) => {
  const fake = await startFake2N();
  t.after(() => fake.close());
  const host = { address: '127.0.0.1', port: fake.port, key: fake.host };
  const session = {};
  const auth = { mode: 'digest', username: USER, password: PASSWORD };
  await realRequest({ host, pins: [FP], auth, session, path: '/api/system/info', timeout: 3000 });
  fake.latency['/api/system/info'] = 200;
  const wrong = realRequest({
    host,
    pins: [FP],
    auth: { ...auth, password: 'wrong' },
    session,
    path: '/api/system/info',
    timeout: 3000,
  });
  await sleep(80);
  const other = { ...session.challenge, nonce: 'installed-by-another' };
  session.challenge = other;
  await assert.rejects(wrong, { kind: 'refused' });
  assert.equal(session.challenge, other);
});

// --- backoffs (R3, R4, R5) and the test button (R21) -----------------------------

test('a failing event channel is asked again less and less often (R3)', async (t) => {
  const s = await setup(t);
  s.fake.status['/api/log/subscribe'] = 500;
  const at = timesOf(s, '/api/log/subscribe');
  await s.ready();
  await events(s, () => at.length >= 4, 'subscriptions', 200);
  const gaps = at.slice(1).map((v, i) => v - at[i]);
  assert.ok(gaps[1] > gaps[0] && gaps[2] > gaps[1], `gaps ${gaps}`);
});

test('an unknown channel (error 12) is subscribed again at once only once (R4)', async (t) => {
  const s = await setup(t);
  s.fake.code['/api/log/pull'] = 12;
  const at = timesOf(s, '/api/log/subscribe');
  await s.ready();
  await events(s, () => at.length >= 1, 'first');
  for (let i = 0; i < 30; i += 1) {
    await s.advance(1000);
    await sleep(30);
  }
  assert.ok(at.length <= 6, `${at.length} subscriptions in 30 s`);
});

test('an unreachable intercom is asked again less and less often (R5)', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.status['/api/system/info'] = 503;
  const at = timesOf(s, '/api/system/info');
  for (let i = 0; i < 160 && at.length < 4; i += 1) {
    await s.advance(5000);
    await sleep(20);
  }
  const gaps = at.slice(1).map((v, i) => v - at[i]);
  assert.ok(gaps.length >= 2 && gaps[1] > gaps[0], `gaps ${gaps}`);
});

test('the test button: once per address every 5 s (R21)', async (t) => {
  const s = await setup(t);
  await s.ready();
  await within(s.gladys.fake.action('test_connection'), 5000);
  const again = await within(s.gladys.fake.action('test_connection'), 5000);
  assert.match(said(again), /moins de 5 s/);
});

// --- /data (I3, R24) -------------------------------------------------------------------

test('/data unreadable at start is read again every 10 s; its pin is then used (I3)', async (t) => {
  const data = emptyData();
  const fake = await startFake2N();
  data.pins[fake.host] = FP;
  const store = new MemoryStore(data, { state: 'unreadable' });
  const s = await setup(t, { fakes: [fake], store, config: { fingerprints: '' } });
  await s.step(0);
  await until(() => s.session().state === 'untrusted');
  await s.advance(10_000);
  await sleep(30);
  assert.equal(s.app.storeState, 'unreadable', 'still unreadable');
  store.state = 'ok';
  await s.advance(10_000);
  await sleep(30);
  assert.equal(s.app.storeState, 'ok');
  await s.step(0);
  await until(() => s.session().state === 'ok');
  await s.app.stop();
  assert.equal(s.app.dataTimer, undefined);
});

test('/data unreadable: retried on its timer, stopped by stop() (I3)', async (t) => {
  const store = new MemoryStore(emptyData(), { state: 'unreadable' });
  const s = await setup(t, { store });
  await s.ready();
  assert.notEqual(s.app.dataTimer, undefined);
  await s.advance(10_000);
  await sleep(20);
  assert.notEqual(s.app.dataTimer, undefined, 'armed again after a failed read');
  await s.app.stop();
  assert.equal(s.app.dataTimer, undefined);
  assert.equal(s.pending.size, 0, 'no timer left');
});

test('two clicks with /data unreadable trust nothing and write nothing (R24)', async (t) => {
  const store = new MemoryStore(emptyData(), { state: 'unreadable' });
  const s = await setup(t, { store, config: { fingerprints: '' } });
  await s.step(0);
  await within(s.gladys.fake.action('trust_certificates'), 5000);
  const second = await within(s.gladys.fake.action('trust_certificates'), 5000);
  assert.match(said(second), /NON approuvé/);
  assert.equal(store.saves, 0);
  assert.deepEqual(s.app.data.pins, {});
});

// --- activation marks and confirmation (I1, M2, R13, R14, R22) --------------------

test('already active before the activation: never "confirmed" (M2, R13)', async (t) => {
  const s = await setup(t);
  await s.ready();
  await events(s, () => s.session().channel !== undefined, 'channel');
  s.fake.switches[1].active = true; // opened by a code, its event not read yet
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /accepté/);
  await events(s, () => s.session().ownOpens.length === 0, 'event read', 10);
  assert.doesNotMatch(s.gladys.fake.connectionStatus.message.fr, /confirmé/);
});

test('an activation answered by an error of the device leaves no mark (I1)', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.switches[1].locked = true;
  const ack = await press(s.gladys, 1);
  assert.match(ack.error, /refusée par l’interphone/);
  assert.equal(s.session().ownOpens.length, 0);
});

test('the mark of an activation lasts 30 s: a later API activation is an event (R14)', async (t) => {
  const s = await setup(t);
  await s.ready();
  await events(s, () => s.session().channel !== undefined, 'channel');
  s.fake.activateOnTrigger = false;
  s.fake.drop.add('/api/switch/ctrl');
  const ack = await press(s.gladys, 1);
  assert.match(ack.error, /envoyée, sans réponse/);
  assert.equal(s.session().ownOpens.length, 1);
  await s.advance(31_000);
  await sleep(30);
  s.fake.push('SwitchStateChanged', { switch: 1, state: true, originator: 'api' });
  await events(
    s,
    () => s.gladys.fake.sceneEvents.some((e) => e.key === 'switch_activated'),
    'event',
  );
});

test('marks of activations are bounded (R22)', async (t) => {
  const s = await setup(t);
  await s.ready();
  for (let i = 0; i < 20; i += 1) s.session().markOwnOpen(1, s.clock.now, false);
  assert.equal(s.session().ownOpens.length, 8);
});

// --- event channel (R6, R20, R23), limits (R9, R10) ---------------------------------

const pullAnswer = (events) => ({
  status: 200,
  headers: {},
  text: JSON.stringify({ success: true, result: { events } }),
});
const bell = {
  id: 1,
  upTime: 5,
  event: 'CallStateChanged',
  params: { direction: 'outgoing', state: 'ringing', session: 4 },
};

test('a channel read answered for another intercom is not applied (R6)', async (t) => {
  let session;
  let changed = false;
  const s = await setup(t, {
    request: async (options) => {
      if (options.path.startsWith('/api/log/pull') && !changed) {
        changed = true;
        session.identity = { ...session.identity, serial: '54-9999-9999' };
        return pullAnswer([bell]);
      }
      return realRequest(options);
    },
  });
  await s.ready();
  session = s.session();
  await events(s, () => changed, 'pull');
  await sleep(50);
  assert.equal(s.gladys.fake.sceneEvents.length, 0);
});

test('a read of an old channel is not applied (R20)', async (t) => {
  let session;
  let changed = false;
  const s = await setup(t, {
    request: async (options) => {
      if (options.path.startsWith('/api/log/pull') && !changed) {
        changed = true;
        session.channel = 999_999; // subscribed again meanwhile
        return pullAnswer([bell]);
      }
      return realRequest(options);
    },
  });
  await s.ready();
  session = s.session();
  await events(s, () => changed, 'pull');
  await sleep(50);
  assert.equal(s.gladys.fake.sceneEvents.length, 0);
});

test('calls remembered are bounded (R23)', async (t) => {
  const s = await setup(t);
  await s.ready();
  for (let i = 0; i < 50; i += 1) {
    s.session().onEvent({
      event: 'CallStateChanged',
      params: { direction: 'outgoing', state: 'ringing', session: i },
    });
  }
  assert.equal(s.session().calls.size, 32);
});

test('states and scene events are rate limited (R9, R10)', async (t) => {
  const s = await setup(t);
  await s.ready();
  const before = s.gladys.fake.states.length;
  for (let i = 0; i < 300; i += 1) s.app.publishState(s.session(), 'call:ring', i % 2);
  await sleep(100);
  assert.ok(s.gladys.fake.states.length - before <= 250);
  for (let i = 0; i < 130; i += 1) s.app.sceneEvent('doorbell', { device: D() });
  await sleep(100);
  assert.equal(s.gladys.fake.sceneEvents.length, 120);
});

// --- stop (R11, R12), bounds (R19) ----------------------------------------------------

test('stop() closes a held channel read at once (R11)', async (t) => {
  const s = await setup(t, { fake: { pullHoldMs: 10_000 } });
  await s.ready();
  await events(s, () => s.session().channel !== undefined, 'channel');
  await s.advance(1000);
  await until(() => s.fake.openSockets.size >= 1);
  await s.app.stop();
  await until(() => s.fake.openSockets.size === 0, 1500);
});

test('stop() leaves no follow-up read armed (R12)', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.activateOnTrigger = false;
  const ack = await press(s.gladys, 1);
  assert.match(ack.error, /accepté/);
  assert.ok(s.session().followTimers.size > 0);
  const session = s.session();
  await s.app.stop();
  assert.equal(session.followTimers.size, 0);
  assert.equal(s.pending.size, 0);
  assert.equal(s.gladys.fake.lastState(F('switch-1:state')), 1);
});

test('a declared length too large is refused before the body comes (R19)', async (t) => {
  const server = createServer({ key: CERTS.device.key, cert: CERTS.device.cert }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 50 * 1024 * 1024 });
    res.write('{"success":true');
    // ... and nothing more for a long time.
  });
  server.on('connection', (socket) => t.after(() => socket.destroy()));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const started = Date.now();
  await assert.rejects(
    realRequest({
      host: { address: '127.0.0.1', port: server.address().port },
      pins: [FP],
      path: '/x',
      timeout: 3000,
    }),
    { kind: 'answer' },
  );
  assert.ok(Date.now() - started < 1500);
  assert.equal(triggers({ requests: [] }).length, 0);
});
