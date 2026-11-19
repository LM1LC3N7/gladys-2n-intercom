// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and
// fake intercoms on real loopback HTTPS sockets: the readings really leave
// every interval, measured from the start of the previous cycle (time sped up
// 20 times: 10 s is 0.5 s); activations go end to end on the real clock, not
// sped up, with slow intercoms (their budget is real time). Every app is
// stopped in t.after, every wait is bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IntercomApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { Session } from '../src/session.js';
import { MemoryStore } from '../src/store.js';
import { FP, PASSWORD, USER, startFake2N } from './helpers/fake2n.js';
import { sleep, until, within } from './helpers/app.js';

/** The app on the real clock, `speed` times faster. */
function realApp(t, fakes, speed, config = {}) {
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / speed);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({
    selector: '2n-intercom',
    config: {
      hosts: fakes.map((f) => f.host).join(','),
      auth: 'none',
      allow_open: true,
      fingerprints: FP,
      ...config,
    },
  });
  const quiet = () => {};
  const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet };
  const app = new IntercomApp({
    gladys,
    logger,
    store: new MemoryStore(),
    timers,
    now: () => Date.now() * speed,
    monotonic: () => performance.now() * speed,
  });
  registerHandlers(gladys, app, logger, timers);
  t.after(() => app.stop());
  return { gladys, app, timersSet: () => timersSet };
}

test('real clock x20: a reading every 10 s, never sooner, never a cycle late', async (t) => {
  const fake = await startFake2N({ auth: 'none', latency: { '/api/switch/status': 30 } });
  t.after(() => fake.close());
  // The event channel waits its 20 s (1 s real) like a device.
  fake.pullHoldMs = 1000;
  // The method that decides is spied (the requests' latency would blur the period).
  const at = [];
  const start = performance.now();
  const original = Session.prototype.cycle;
  Session.prototype.cycle = function cycle(...args) {
    at.push(Math.round((performance.now() - start) * 20));
    return original.apply(this, args);
  };
  t.after(() => {
    Session.prototype.cycle = original;
  });
  const { gladys, timersSet } = realApp(t, [fake], 20);
  await within(gladys.connect(), 5000);
  const end = start + 65_000 / 20;
  while (performance.now() < end) await sleep(5);
  assert.ok(at.length >= 6 && at.length <= 8, `readings at ${at}`);
  for (let i = 1; i < at.length; i += 1) {
    const gap = at[i] - at[i - 1];
    assert.ok(gap >= 0.9 * 10_000, `never sooner than 10 s: ${at}`);
    assert.ok(gap < 1.5 * 10_000, `on time: ${at}`);
  }
  // The event channel: one subscription, reads that wait (no tight loop).
  assert.equal(fake.requests.filter((r) => r.path === '/api/log/subscribe').length, 1);
  assert.ok(fake.requests.filter((r) => r.path === '/api/log/pull').length <= 6);
  assert.ok(timersSet() < 60, `timers bounded: ${timersSet()}`);
});

test('real clock: an event channel answering at once without events is read once a second at most', async (t) => {
  const fake = await startFake2N({ auth: 'none' });
  fake.pullHoldMs = 0;
  t.after(() => fake.close());
  const { gladys } = realApp(t, [fake], 1);
  await within(gladys.connect(), 5000);
  await sleep(2500);
  const pulls = fake.requests.filter((r) => r.path === '/api/log/pull').length;
  assert.ok(pulls >= 1 && pulls <= 4, `${pulls} reads in 2.5 s`);
});

test('real clock: 5 slow intercoms (500 ms per answer) activated by one scene, within the ack budget', async (t) => {
  const fakes = [];
  for (let i = 0; i < 5; i += 1) {
    const fake = await startFake2N({ auth: 'none' });
    fake.info.serialNumber = `54-0000-000${i}`;
    fakes.push(fake);
  }
  t.after(() => Promise.all(fakes.map((f) => f.close())));
  const { gladys, app } = realApp(t, fakes, 1);
  await within(gladys.connect(), 5000);
  await until(
    () => [...app.sessions.values()].every((s) => s.state === 'ok' && s.timer && s.caps.size),
    5000,
  );
  for (const fake of fakes) fake.latency['*'] = 500;
  const started = performance.now();
  const acks = await within(
    Promise.all(
      fakes.map((_, i) =>
        gladys.fake.setValue(
          { external_id: `ext:2n-intercom:2n:54-0000-000${i}` },
          { external_id: `ext:2n-intercom:2n:54-0000-000${i}:switch-1:open` },
          1,
        ),
      ),
    ),
    8000,
  );
  const took = performance.now() - started;
  assert.ok(
    acks.every((a) => a.success || /accepté/.test(a.error)),
    JSON.stringify(acks),
  );
  assert.ok(took < 3600, `${Math.round(took)} ms`);
  assert.equal(fakes.filter((f) => f.count('/api/switch/ctrl') === 1).length, 5);
});

test('real clock: an intercom answering in 4 s is never activated late ("nothing sent" in time)', async (t) => {
  const fake = await startFake2N({ auth: 'none' });
  t.after(() => fake.close());
  const { gladys, app } = realApp(t, [fake], 1);
  await within(gladys.connect(), 5000);
  await until(() => [...app.sessions.values()].every((s) => s.state === 'ok' && s.timer), 5000);
  fake.latency['/api/system/info'] = 4000;
  const started = performance.now();
  const ack = await within(
    gladys.fake.setValue(
      { external_id: 'ext:2n-intercom:2n:54-0123-4567' },
      { external_id: 'ext:2n-intercom:2n:54-0123-4567:switch-1:open' },
      1,
    ),
    6000,
  );
  assert.ok(performance.now() - started < 4000);
  assert.equal(ack.success, false);
  assert.match(ack.error, /rien envoyé/);
  await sleep(200);
  assert.equal(fake.count('/api/switch/ctrl'), 0);
});

test('real clock: an activation while a channel read is held is never a "switch activated" event (I1)', async (t) => {
  for (const latency of [0, 200]) {
    const fake = await startFake2N({ auth: 'none' });
    fake.pullHoldMs = 3000; // a real device holds the read up to 20 s
    fake.latency['/api/switch/ctrl'] = latency;
    t.after(() => fake.close());
    const { gladys, app } = realApp(t, [fake], 1);
    await within(gladys.connect(), 5000);
    await until(
      () => [...app.sessions.values()].every((s) => s.state === 'ok' && s.caps.size),
      5000,
    );
    await until(() => fake.requests.some((r) => r.path === '/api/log/pull'), 5000);
    await sleep(100);
    const ack = await within(
      gladys.fake.setValue(
        { external_id: 'ext:2n-intercom:2n:54-0123-4567' },
        { external_id: 'ext:2n-intercom:2n:54-0123-4567:switch-1:open' },
        1,
      ),
      6000,
    );
    assert.equal(ack.success, true, ack.error);
    await sleep(300);
    const session = [...app.sessions.values()][0];
    assert.equal(gladys.fake.sceneEvents.filter((e) => e.key === 'switch_activated').length, 0);
    assert.equal(session.ownOpens.length, 0, 'the mark was taken by its own event');
    await app.stop();
  }
});

test('real clock: the trigger step keeps to the deadline, the ack comes in time (R15)', async (t) => {
  const fake = await startFake2N({ auth: 'none' });
  t.after(() => fake.close());
  const { gladys, app } = realApp(t, [fake], 1);
  await within(gladys.connect(), 5000);
  await until(() => [...app.sessions.values()].every((s) => s.state === 'ok' && s.timer), 5000);
  // 2.4 s for identity and capabilities: the trigger has ~0.9 s left, never its full 1.5 s.
  fake.latency['/api/system/info'] = 1200;
  fake.latency['/api/switch/caps'] = 1200;
  fake.silent.add('/api/switch/ctrl');
  const started = performance.now();
  const ack = await within(
    gladys.fake.setValue(
      { external_id: 'ext:2n-intercom:2n:54-0123-4567' },
      { external_id: 'ext:2n-intercom:2n:54-0123-4567:switch-1:open' },
      1,
    ),
    7000,
  );
  const took = performance.now() - started;
  assert.equal(ack.success, false);
  assert.ok(took < 3600, `${Math.round(took)} ms`);
});

test('real clock: 5 intercoms answering in 1.1 s, one scene: 5 triggers leave, acks in time (M2 r2)', async (t) => {
  const fakes = [];
  for (let i = 0; i < 5; i += 1) {
    const fake = await startFake2N({ auth: 'none' });
    fake.info.serialNumber = `54-0000-001${i}`;
    fakes.push(fake);
  }
  t.after(() => Promise.all(fakes.map((f) => f.close())));
  const { gladys, app } = realApp(t, fakes, 1);
  await within(gladys.connect(), 5000);
  await until(
    () => [...app.sessions.values()].every((s) => s.state === 'ok' && s.timer && s.caps.size),
    5000,
  );
  for (const fake of fakes) fake.latency['*'] = 1100;
  const started = performance.now();
  const acks = await within(
    Promise.all(
      fakes.map((_, i) =>
        gladys.fake.setValue(
          { external_id: `ext:2n-intercom:2n:54-0000-001${i}` },
          { external_id: `ext:2n-intercom:2n:54-0000-001${i}:switch-1:open` },
          1,
        ),
      ),
    ),
    8000,
  );
  const took = performance.now() - started;
  assert.ok(took < 3600, `${Math.round(took)} ms`);
  await sleep(1300);
  assert.equal(
    fakes.filter((f) => f.count('/api/switch/ctrl') === 1).length,
    5,
    JSON.stringify(acks),
  );
});

test('real clock: with less than 2 s left, the state before an opening is not even asked (M2 r2)', async (t) => {
  const fake = await startFake2N({ auth: 'none' });
  t.after(() => fake.close());
  const { gladys, app } = realApp(t, [fake], 1);
  await within(gladys.connect(), 5000);
  await until(() => [...app.sessions.values()].every((s) => s.state === 'ok' && s.timer), 5000);
  fake.latency['/api/system/info'] = 700;
  fake.latency['/api/switch/caps'] = 700;
  fake.latency['/api/switch/status'] = 1100;
  const mark = fake.requests.length;
  await within(
    gladys.fake.setValue(
      { external_id: 'ext:2n-intercom:2n:54-0123-4567' },
      { external_id: 'ext:2n-intercom:2n:54-0123-4567:switch-1:open' },
      1,
    ),
    7000,
  );
  const after = fake.requests
    .slice(mark)
    .map((r) => `${r.path}${r.query.switch ? `?${r.query.switch}` : ''}`);
  const trigger = after.indexOf('/api/switch/ctrl?1');
  assert.ok(trigger > 0, JSON.stringify(after));
  assert.ok(!after.slice(0, trigger).includes('/api/switch/status?1'), JSON.stringify(after));
});

test('real clock: a held channel read renews an expired Digest nonce; openings and readings do not wait for it (I1 r4)', async (t) => {
  for (const nonceEach401 of [false, true]) {
    for (const what of ['open', 'read']) {
      const fake = await startFake2N({ nonceEach401 });
      fake.pullHoldMs = 4000; // a real device holds the read up to 20 s
      t.after(() => fake.close());
      const digest = { auth: 'digest', username: USER, password: PASSWORD };
      const { gladys, app } = realApp(t, [fake], 1, digest);
      await within(gladys.connect(), 5000);
      const session = () => [...app.sessions.values()][0];
      await until(() => session()?.state === 'ok' && session().caps.size, 5000);
      const held = (from) =>
        fake.requests.slice(from).some((r) => r.path === '/api/log/pull' && r.authorized);
      await until(() => held(0), 5000);
      await sleep(100);
      // The device expires its nonce; the held read answers an event, the next
      // one gets the 401 and renews: its second round is held 4 s.
      fake.nonce = `expired${nonceEach401 ? 'E' : 'F'}0123456789abcdef`;
      const mark = fake.requests.length;
      fake.push('InputChanged', { port: 'input1', state: true });
      await until(() => held(mark), 3000);
      const label = `nonceEach401=${nonceEach401}, ${what}`;
      assert.equal(fake.requests.slice(mark).find((r) => !r.authorized)?.path, '/api/log/pull');
      const started = performance.now();
      if (what === 'open') {
        const ack = await within(
          gladys.fake.setValue(
            { external_id: 'ext:2n-intercom:2n:54-0123-4567' },
            { external_id: 'ext:2n-intercom:2n:54-0123-4567:switch-1:open' },
            1,
          ),
          5000,
        );
        assert.equal(ack.success, true, `${label}: ${ack.error}`);
        assert.equal(fake.count('/api/switch/ctrl'), 1, label);
      } else {
        const asked = fake.count('/api/system/info');
        session().schedule(0);
        await until(() => fake.count('/api/system/info') > asked, 2500);
      }
      const took = performance.now() - started;
      assert.ok(took < 2500, `${label}: ${Math.round(took)} ms`);
      assert.equal(session().state, 'ok', label);
      await app.stop();
    }
  }
});
