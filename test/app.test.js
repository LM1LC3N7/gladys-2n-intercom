// -----------------------------------------------------------------------------
// The integration end to end: the fake Gladys of the SDK, the handlers of the
// container, fake 2N intercoms on loopback HTTPS, a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { request as realRequest } from '../src/http.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { CERTS, FP, PASSWORD, startFake2N } from './helpers/fake2n.js';
import { D, F, createAll, press, setup, sleep, until, within } from './helpers/app.js';

const POLL = 10_000;

/** One full reading cycle of device `i` (its timer is due after the interval). */
async function cycle(s, i = 0, ms = POLL) {
  await s.advance(ms);
  await until(() => s.session(i).timer !== undefined && !s.session(i).currentRead, 4000);
  await sleep(5);
}

/** Moves the clock 1 s at a time (the event channel reads) until `condition()` holds. */
async function events(s, condition, what = 'events') {
  for (let i = 0; i < 40; i += 1) {
    if (condition()) return;
    await s.advance(1000);
    await sleep(40);
  }
  assert.ok(condition(), `${what}: not met`);
}

const listening = (s, i = 0) => events(s, () => s.session(i).channel !== undefined, 'channel');

/** The French text of an action answer. */
const said = (answer) => answer.data?.message?.fr ?? String(answer.data);

const triggers = (fake) => fake.requests.filter((r) => r.path === '/api/switch/ctrl');

test('discovery: the serial number makes the ids; doorbell, switch states and buttons, inputs', async (t) => {
  const s = await setup(t);
  await s.ready();
  await until(() => s.gladys.fake.discoveredDevices.length === 1);
  const [device] = s.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, D());
  assert.equal(device.name, '2N IP Verso Portail');
  const byId = Object.fromEntries(device.features.map((f) => [f.external_id, f]));
  assert.deepEqual(Object.keys(byId).sort(), [
    F('call:ring'),
    F('input-input1:state'),
    F('switch-1:open'),
    F('switch-1:state'),
    F('switch-2:open'),
    F('switch-2:state'),
  ]);
  for (const feature of device.features) {
    assert.notEqual(feature.category, 'switch', 'never a switch');
    assert.equal(feature.supported_options, undefined);
  }
  assert.equal(byId[F('switch-1:open')].category, 'button');
  assert.equal(byId[F('switch-1:open')].type, 'push');
  assert.equal(byId[F('switch-1:state')].category, 'lock');
  assert.equal(byId[F('switch-1:state')].read_only, true);
  assert.equal(byId[F('call:ring')].category, 'doorbell');
  assert.equal(byId[F('call:ring')].read_only, true);
  assert.equal(byId[F('input-input1:state')].category, 'input');
  assert.equal(byId[F('input-input1:state')].read_only, true);
  assert.equal(s.gladys.fake.lastState(F('switch-1:state')), 1);
  assert.equal(s.gladys.fake.lastState(F('call:ring')), 0);
  assert.equal(s.gladys.fake.lastState(F('input-input1:state')), 0);
  await until(() => s.gladys.fake.connectionStatus?.connected === true);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /2N IP Verso, 2 relais/);
  s.fake.switches[2].active = true;
  s.fake.inputs.input1 = 1;
  s.fake.sessions = [{ session: 3, direction: 'outgoing', state: 'ringing' }];
  await cycle(s);
  assert.equal(s.gladys.fake.lastState(F('switch-2:state')), 0);
  assert.equal(s.gladys.fake.lastState(F('input-input1:state')), 1);
  assert.equal(s.gladys.fake.lastState(F('call:ring')), 1);
});

test('the supported_options rule of the core holds for every published feature', async (t) => {
  const s = await setup(t);
  await s.ready();
  const core = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
  const normalize = existsSync(core)
    ? createRequire(import.meta.url)(core).normalizeSupportedOptions
    : undefined;
  for (const feature of s.gladys.fake.discoveredDevices.flatMap((d) => d.features)) {
    const options = feature.supported_options;
    if (options === undefined) continue;
    for (const option of options) {
      assert.equal(typeof option.label, 'string');
      assert.equal(option.label, option.label.trim());
      assert.ok(option.label);
    }
    if (normalize) assert.deepEqual(normalize(options, { allowStringValues: true }), options);
  }
});

test('no certificate trusted: nothing sent (a handshake only), the fingerprint shown', async (t) => {
  const s = await setup(t, { config: { fingerprints: '' } });
  await s.step(0);
  await until(() => s.session().state === 'untrusted' && s.session().seen === FP);
  await s.advance(10 * POLL);
  await sleep(20);
  assert.equal(s.fake.requests.length, 0, 'not one HTTP request');
  await until(() => s.gladys.fake.connectionStatus?.message?.fr.includes(FP));
  assert.equal(s.gladys.fake.connectionStatus.connected, false);
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, false);
  assert.equal(s.fake.requests.length, 0);
});

test('trust in two clicks: the first shows, the second pins (kept in /data), then reads', async (t) => {
  const s = await setup(t, { config: { fingerprints: '' } });
  await s.step(0);
  await until(() => s.session().state === 'untrusted');
  const first = await within(s.gladys.fake.action('trust_certificates'), 5000);
  assert.equal(first.success, true);
  assert.match(said(first), new RegExp(FP));
  assert.match(said(first), /cliquez à nouveau/);
  assert.equal(s.store.saves, 0);
  assert.equal(s.fake.requests.length, 0);
  const second = await within(s.gladys.fake.action('trust_certificates'), 5000);
  assert.match(said(second), /Certificat approuvé/);
  assert.equal(s.store.data.pins[s.fake.host], FP);
  await s.step(0);
  await until(() => s.session().state === 'ok');
  assert.ok(s.fake.count('/api/system/info') >= 1);
});

test('trust: a second click after 2 minutes, or seeing another certificate, pins nothing', async (t) => {
  const s = await setup(t, { config: { fingerprints: '' } });
  await s.step(0);
  await within(s.gladys.fake.action('trust_certificates'), 5000);
  await s.advance(121_000);
  const late = await within(s.gladys.fake.action('trust_certificates'), 5000);
  assert.match(said(late), /cliquez à nouveau/);
  assert.deepEqual(s.store.data.pins, {});
  s.fake.useCert(CERTS.impostor);
  const other = await within(s.gladys.fake.action('trust_certificates'), 5000);
  assert.match(said(other), /cliquez à nouveau/);
  assert.ok(said(other).includes(CERTS.impostor.fingerprint256));
  assert.deepEqual(s.store.data.pins, {});
  assert.equal(s.fake.requests.length, 0);
});

test('trust: /data not written, the certificate is not trusted', async (t) => {
  const store = new MemoryStore();
  store.failing = true;
  const s = await setup(t, { config: { fingerprints: '' }, store });
  await s.step(0);
  await within(s.gladys.fake.action('trust_certificates'), 5000);
  const second = await within(s.gladys.fake.action('trust_certificates'), 5000);
  assert.match(said(second), /NON approuvé/);
  assert.deepEqual(s.app.data.pins, {});
  await s.advance(POLL);
  await sleep(20);
  assert.equal(s.fake.requests.length, 0);
});

test('another certificate: nothing sent, never learnt, fingerprint shown, password never sent', async (t) => {
  const s = await setup(t);
  await s.ready();
  const before = s.fake.requests.length;
  s.fake.useCert(CERTS.impostor);
  await cycle(s);
  await until(() => s.session().state === 'pin');
  assert.equal(s.fake.requests.length, before, 'nothing written to the impostor');
  assert.equal(s.session().seen, CERTS.impostor.fingerprint256);
  await until(() =>
    s.gladys.fake.connectionStatus.message.fr.includes(CERTS.impostor.fingerprint256),
  );
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /autre certificat/);
  assert.equal(triggers(s.fake).length, 0);
  assert.equal(s.fake.requests.length, before);
  // Looked at again later (a handshake): still nothing written.
  await s.advance(300_000);
  await sleep(50);
  assert.equal(s.fake.requests.length, before);
});

test('activation off by default: refused, nothing sent', async (t) => {
  const s = await setup(t, { config: { allow_open: undefined } });
  await s.ready();
  await createAll(s.gladys);
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /ouverture désactivée/);
  assert.equal(triggers(s.fake).length, 0);
  await until(() => /ouverture désactivée/.test(s.gladys.fake.connectionStatus.message.fr));
});

test('activation: identity and capabilities read right before, trigger, confirmed by a reading', async (t) => {
  const s = await setup(t);
  await s.ready();
  const before = s.fake.requests.length;
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data, /confirmé/);
  const after = s.fake.requests
    .slice(before)
    .filter((r) => r.authorized && !r.path.startsWith('/api/log'));
  assert.deepEqual(
    after.map((r) => r.path),
    ['/api/system/info', '/api/switch/caps', '/api/switch/ctrl', '/api/switch/status'],
  );
  assert.deepEqual(after[2].query, { switch: '1', action: 'trigger' });
  assert.equal(s.gladys.fake.lastState(F('switch-1:state')), 0);
  assert.ok(s.lines.some((l) => /Opening .* switch 1: accepted/.test(l)));
});

test('activation refused before anything leaves: bistable, disabled, too long, mode unknown', async (t) => {
  const s = await setup(t);
  await s.ready();
  const ack2 = await press(s.gladys, 2);
  assert.match(ack2.error, /bistable/);
  s.fake.caps[0].switchOnDuration = 61;
  assert.match((await press(s.gladys, 1)).error, /plus de 60 s/);
  s.fake.caps[0].switchOnDuration = undefined;
  assert.match((await press(s.gladys, 1)).error, /illisible/);
  s.fake.caps[0] = { switch: 1, enabled: true, switchOnDuration: 5 };
  assert.match((await press(s.gladys, 1)).error, /illisible/);
  s.fake.caps[0] = { switch: 1, enabled: false };
  assert.match((await press(s.gladys, 1)).error, /désactivé sur l’interphone/);
  s.fake.code['/api/switch/caps'] = 10;
  s.fake.codeStatus['/api/switch/caps'] = 401;
  assert.match((await press(s.gladys, 1)).error, /rien envoyé \(droit/);
  assert.equal(triggers(s.fake).length, 0);
  assert.notEqual(s.session().state, 'refused');
});

test('activation: the option unchecked while the command waits: nothing sent', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['/api/switch/caps'] = 300;
  const pending = press(s.gladys, 1);
  await sleep(100);
  s.app.config = { ...s.app.config, allowOpen: false };
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /rien envoyé/);
  assert.equal(triggers(s.fake).length, 0);
});

test('activation: another intercom at the address (serial changed): refused, nothing sent', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.info.serialNumber = '54-9999-0000';
  const ack = await press(s.gladys, 1);
  assert.match(ack.error, /un autre interphone/);
  assert.equal(triggers(s.fake).length, 0);
});

test('activation never sent twice: no answer is "sent, maybe activated", one trigger', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.drop.add('/api/switch/ctrl');
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans réponse/);
  await s.advance(10 * POLL);
  await sleep(50);
  assert.equal(triggers(s.fake).filter((r) => r.authorized).length, 1);
});

test('activation refused by the intercom (locked switch, error 14): said so', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.switches[1].locked = true;
  const ack = await press(s.gladys, 1);
  assert.match(ack.error, /refusée par l’interphone/);
});

test('a slow reading in flight is never applied after an activation', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['/api/switch/status'] = 200;
  const reading = s.advance(POLL);
  await until(() => s.session().currentRead !== undefined);
  s.fake.latency['/api/switch/status'] = 0;
  const ack = await press(s.gladys, 1);
  assert.match(ack.data ?? ack.error, /confirmé/);
  await reading;
  await sleep(300);
  assert.equal(s.gladys.fake.lastState(F('switch-1:state')), 0);
});

test('too many commands waiting on one intercom: refused at once', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['*'] = 300;
  const acks = await Promise.all(Array.from({ length: 6 }, () => press(s.gladys, 1)));
  assert.ok(acks.some((a) => /trop de commandes/.test(a.error ?? '')));
  assert.ok(triggers(s.fake).filter((r) => r.authorized).length <= 4);
});

test('commands that are not an activation, a wrong value, an unknown device: refused', async (t) => {
  const s = await setup(t);
  await s.ready();
  const device = { external_id: D() };
  const cases = [
    [{ external_id: F('switch-1:state') }, 1, /pas une commande/],
    [{ external_id: F('call:ring') }, 1, /pas une commande/],
    [{ external_id: F('switch-1:open') }, 0, /valeur inattendue/],
    [{ external_id: F('switch-5:open') }, 1, /inconnu/],
    [{ external_id: F('switch-1:open', '54-0000-1111') }, 1, /inconnu/],
    [{ external_id: 'ext:2n-intercom:other:x' }, 1, /inconnu/],
  ];
  for (const [feature, value, error] of cases) {
    const ack = await within(s.gladys.fake.setValue(device, feature, value), 5000);
    assert.equal(ack.success, false);
    assert.match(ack.error, error);
  }
  assert.equal(triggers(s.fake).length, 0);
});

test('an endpoint not allowed (error 10 with 401) is no refusal: the others are read', async (t) => {
  const s = await setup(t);
  s.fake.code['/api/io/caps'] = 10;
  s.fake.codeStatus['/api/io/caps'] = 401;
  s.fake.code['/api/log/subscribe'] = 10;
  await s.ready();
  assert.equal(s.session().state, 'ok');
  assert.equal(s.gladys.fake.lastState(F('switch-1:state')), 1);
  await events(s, () => s.session().ep.events.state === 'denied', 'events denied');
  await until(() =>
    /lecture des entrées non autorisée/.test(s.gladys.fake.connectionStatus.message.fr),
  );
  assert.match(s.gladys.fake.connectionStatus.message.fr, /lecture des événements non autorisée/);
  assert.deepEqual(s.store.data.refused, {});
  // Asked again after a minute, not at every cycle.
  const asked = s.fake.requests.filter((r) => r.path === '/api/io/caps').length;
  await cycle(s);
  assert.equal(s.fake.requests.filter((r) => r.path === '/api/io/caps').length, asked);
});

test('credentials refused on the identity: no more tries, kept in /data, lifted by the test button', async (t) => {
  const s = await setup(t, { fake: { password: 'other' } });
  await s.step(0);
  await until(() => s.session().state === 'refused');
  assert.ok(s.store.data.refused[s.fake.host]);
  const asked = s.fake.requests.length;
  await s.advance(20 * POLL);
  await sleep(20);
  assert.equal(s.fake.requests.length, asked);
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, false);
  assert.equal(s.fake.requests.length, asked);
  await until(() => /identifiants refusés/.test(s.gladys.fake.connectionStatus.message.fr));
  s.fake.password = PASSWORD;
  const test = await within(s.gladys.fake.action('test_connection'), 5000);
  assert.match(said(test), /connexion réussie/);
  await s.step(0);
  await until(() => s.session().state === 'ok');
  assert.deepEqual(s.store.data.refused, {});
});

test('credentials refused kept across a restart: not tried again until changed', async (t) => {
  const fake = await startFake2N({ password: 'other' });
  const store = new MemoryStore();
  {
    const s = await setup(t, { fakes: [fake], store });
    await s.step(0);
    await until(() => s.session().state === 'refused');
    await s.app.stop();
  }
  await until(() => Object.keys(store.data.refused).length === 1);
  const asked = fake.requests.length;
  const s2 = await setup(t, { fakes: [fake], store });
  await s2.step(0);
  await sleep(50);
  assert.equal(s2.session().state, 'refused');
  assert.equal(fake.requests.length, asked);
  fake.password = 'new-one';
  await s2.gladys.fake.configUpdated({ ...s2.gladys.fake.config, password: 'new-one' });
  await s2.step(0);
  await until(() => s2.session().state === 'ok');
});

test('events: a doorbell once per call, the ring state follows the call', async (t) => {
  const s = await setup(t);
  await s.ready();
  await listening(s);
  s.fake.push('CallStateChanged', {
    direction: 'outgoing',
    state: 'connecting',
    session: 7,
    peer: 'sip:1@x',
  });
  s.fake.push('CallStateChanged', {
    direction: 'outgoing',
    state: 'ringing',
    session: 7,
    peer: 'sip:1@x',
  });
  await events(s, () => s.gladys.fake.lastState(F('call:ring')) === 1, 'ringing');
  const bells = () => s.gladys.fake.sceneEvents.filter((e) => e.key === 'doorbell');
  assert.equal(bells().length, 1);
  assert.equal(bells()[0].data.device, D());
  s.fake.push('CallStateChanged', { direction: 'outgoing', state: 'connected', session: 7 });
  await events(s, () => s.gladys.fake.lastState(F('call:ring')) === 0, 'answered');
  s.fake.push('CallStateChanged', { direction: 'incoming', state: 'ringing', session: 8 });
  await events(s, () => s.session().eventSeq >= 4, 'incoming');
  assert.equal(bells().length, 1, 'an incoming call is no doorbell');
  assert.equal(s.gladys.fake.lastState(F('call:ring')), 0);
});

test('events: a switch activated by a code is an event, an activation from Gladys is not', async (t) => {
  const s = await setup(t);
  await s.ready();
  await listening(s);
  s.fake.push('SwitchStateChanged', { switch: 1, state: true, originator: 'auth' });
  const switched = () => s.gladys.fake.sceneEvents.filter((e) => e.key === 'switch_activated');
  await events(s, () => switched().length === 1, 'switch event');
  assert.deepEqual(switched()[0].data, { device: D(), switch: '1', originator: 'auth' });
  assert.equal(s.gladys.fake.lastState(F('switch-1:state')), 0);
  s.fake.push('SwitchStateChanged', { switch: 1, state: false, originator: 'auth' });
  await events(s, () => s.gladys.fake.lastState(F('switch-1:state')) === 1, 'off');
  s.fake.switches[1].active = false;
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, true, ack.error);
  await events(s, () => s.session().ownOpens.length === 0, 'own activation seen');
  assert.equal(switched().length, 1, 'the activation from Gladys is no event');
});

test('events: access granted and denied carry no code nor card; inputs update at once', async (t) => {
  const s = await setup(t);
  await s.ready();
  await listening(s);
  s.fake.push('UserAuthenticated', { ap: '0', session: '1', name: 'Alice', uuid: 'u-1' });
  s.fake.push('UserRejected', {
    ap: '1',
    session: '2',
    name: '',
    uuid: '',
    reason: 'invalidCredential',
  });
  s.fake.push('CodeEntered', { code: '1234', valid: true });
  s.fake.push('InputChanged', { port: 'input1', state: true });
  await events(s, () => s.gladys.fake.lastState(F('input-input1:state')) === 1, 'input');
  const granted = s.gladys.fake.sceneEvents.find((e) => e.key === 'access_granted');
  const denied = s.gladys.fake.sceneEvents.find((e) => e.key === 'access_denied');
  assert.deepEqual(granted.data, { device: D(), user: 'Alice', direction: 'entry' });
  assert.deepEqual(denied.data, {
    device: D(),
    user: null,
    direction: 'exit',
    reason: 'invalidCredential',
  });
  assert.ok(!JSON.stringify(s.gladys.fake.sceneEvents).includes('1234'));
  assert.ok(!JSON.stringify(s.gladys.fake.sceneEvents).includes('u-1'));
});

test('events: a channel read after a long silence carries old events, dropped', async (t) => {
  const s = await setup(t);
  await s.ready();
  await listening(s);
  s.session().channelAnswerAt -= 120_000; // the last answer was long ago
  s.fake.push('CallStateChanged', { direction: 'outgoing', state: 'ringing', session: 9 });
  await events(s, () => s.lines.some((l) => /old events/.test(l)), 'dropped');
  assert.equal(s.gladys.fake.sceneEvents.filter((e) => e.key === 'doorbell').length, 0);
});

test('events: an unknown channel (error 12) is subscribed again', async (t) => {
  const s = await setup(t);
  await s.ready();
  await listening(s);
  const first = s.session().channel;
  s.fake.channels.clear();
  await events(
    s,
    () => s.session().channel !== undefined && s.session().channel !== first,
    'again',
  );
  s.fake.push('CallStateChanged', { direction: 'outgoing', state: 'ringing', session: 10 });
  await events(s, () => s.gladys.fake.sceneEvents.some((e) => e.key === 'doorbell'), 'bell');
});

test('a state read before a newer event of the same feature is not applied', async (t) => {
  const s = await setup(t);
  await s.ready();
  await listening(s);
  s.fake.latency['/api/switch/status'] = 400;
  const mark = s.fake.requests.length;
  const reading = s.advance(POLL);
  await until(() =>
    s.fake.requests.slice(mark).some((r) => r.path === '/api/switch/status' && r.authorized),
  );
  // The switch turns on while the reading (of an inactive switch) is in flight.
  s.fake.switches[1].active = true;
  s.fake.push('SwitchStateChanged', { switch: 1, state: true, originator: 'ap' });
  await reading;
  await events(s, () => !s.session().currentRead && s.session().eventSeq > 0, 'event');
  await sleep(500);
  assert.equal(s.gladys.fake.lastState(F('switch-1:state')), 0);
});

test('an unreachable intercom: status said, tried again later, then read', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.silent.add('/api/system/info');
  await s.advance(POLL);
  await until(() => s.session().state === 'down', 4000);
  await until(() => /injoignable/.test(s.gladys.fake.connectionStatus.message.fr));
  s.fake.silent.delete('/api/system/info');
  await s.advanceUntil(() => s.session().state === 'ok', { ms: 120_000, every: 5000 });
});

test('getConfig failing on (re)connection: tried again with a status, then started', async (t) => {
  const s = await setup(t);
  await s.ready();
  let fail = 1;
  const original = s.gladys.getConfig.bind(s.gladys);
  s.gladys.getConfig = async () => {
    if (fail-- > 0) throw new Error('boom');
    return original();
  };
  s.gladys.emit('connected');
  await until(() => /Configuration illisible/.test(s.gladys.fake.connectionStatus?.message?.fr));
  assert.equal(s.gladys.fake.connectionStatus.connected, false);
  await s.step(5000);
  await until(() => s.gladys.fake.connectionStatus.connected === true);
  assert.equal(fail, -1);
});

test('a typed fingerprint changed: the sessions start again with it', async (t) => {
  const s = await setup(t);
  await s.ready();
  await s.gladys.fake.configUpdated({
    ...s.gladys.fake.config,
    fingerprints: CERTS.impostor.fingerprint256,
  });
  await s.step(0);
  await until(() => s.session().state === 'pin');
  await s.gladys.fake.configUpdated({
    ...s.gladys.fake.config,
    fingerprints: FP.replaceAll(':', '').toLowerCase(),
  });
  await s.step(0);
  await until(() => s.session().state === 'ok');
});

test('/data unreadable: never overwritten, said in the status', async (t) => {
  const store = new MemoryStore(emptyData(), { state: 'unreadable' });
  const s = await setup(t, { store, fake: { password: 'other' } });
  await s.step(0);
  await until(() => s.session().state === 'refused');
  await sleep(20);
  assert.equal(store.saves, 0);
  await until(() => /\/data illisible/.test(s.gladys.fake.connectionStatus.message.fr));
});

test('secrets: the password is in no log, status, Discovery, event, /data, action answer', async (t) => {
  const s = await setup(t);
  await s.ready();
  await listening(s);
  await press(s.gladys, 1);
  s.fake.push('UserAuthenticated', { ap: '0', name: 'Bob' });
  await events(s, () => s.gladys.fake.sceneEvents.length > 0, 'event');
  const test = await within(s.gladys.fake.action('test_connection'), 5000);
  const trust = await within(s.gladys.fake.action('trust_certificates'), 5000);
  const everything = JSON.stringify([
    s.lines,
    s.gladys.fake.connectionStatuses,
    s.gladys.fake.discoveredDevices,
    s.gladys.fake.sceneEvents,
    s.gladys.fake.states,
    s.store.data,
    test,
    trust,
  ]);
  assert.ok(!everything.includes(PASSWORD));
  // Basic: the password travels inside TLS only, to the pinned intercom.
  assert.ok(
    s.fake.requests.every((r) => !String(r.headers.authorization ?? '').includes(PASSWORD)),
  );
});

test('activation refused by the option: the reading in flight is left alone', async (t) => {
  const s = await setup(t, { config: { allow_open: false } });
  await s.ready();
  const epoch = s.session().epoch;
  const asked = s.fake.requests.length;
  const ack = await press(s.gladys, 1);
  assert.match(ack.error, /ouverture désactivée/);
  assert.equal(s.session().epoch, epoch);
  assert.equal(s.session().waiting, 0);
  assert.equal(
    s.fake.requests.filter((r, i) => i >= asked && !r.path.startsWith('/api/log')).length,
    0,
  );
});

test('a queued activation whose option is unchecked meanwhile sends not even its identity read', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['/api/switch/caps'] = 300;
  const mark = s.fake.requests.length;
  const first = press(s.gladys, 1);
  await until(() =>
    s.fake.requests.slice(mark).some((r) => r.path === '/api/switch/caps' && r.authorized),
  );
  const second = press(s.gladys, 1);
  await until(() => s.session().waiting === 2);
  s.app.config = { ...s.app.config, allowOpen: false };
  const infos = s.fake.requests.filter((r) => r.path === '/api/system/info').length;
  await first;
  const ack = await second;
  assert.match(ack.error, /ouverture désactivée/);
  assert.equal(s.fake.requests.filter((r) => r.path === '/api/system/info').length, infos);
});

test('two activations: the second reads the identity again when it arrived after the first read it', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['/api/switch/caps'] = 300;
  const mark = s.fake.requests.length;
  const first = press(s.gladys, 1);
  await until(() =>
    s.fake.requests.slice(mark).some((r) => r.path === '/api/switch/caps' && r.authorized),
  );
  const second = press(s.gladys, 1);
  await Promise.all([first, second]);
  const infos = s.fake.requests
    .slice(mark)
    .filter((r) => r.path === '/api/system/info' && r.authorized);
  assert.equal(infos.length, 2);
});

test('activation: the deadline passed when the connection is up: withdrawn, nothing sent', async (t) => {
  const s = await setup(t, {
    request: (options, clock) => {
      if (options.path.startsWith('/api/switch/ctrl')) clock.now += 4000; // a slow handshake
      return realRequest(options);
    },
  });
  await s.ready();
  const ack = await press(s.gladys, 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /rien envoyé \(délai dépassé/);
  assert.equal(triggers(s.fake).filter((r) => r.authorized).length, 0);
});

test('a reading answered after an activation started is never applied', async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let hold = false;
  const s = await setup(t, {
    request: async (options) => {
      if (hold && options.path === '/api/switch/status') {
        hold = false;
        // Answered, but handed back only once the activation is done (an
        // answer already in hand when the command came).
        const answer = await realRequest({ ...options, signal: undefined });
        await held;
        return answer;
      }
      return realRequest(options);
    },
  });
  await s.ready();
  hold = true;
  const reading = s.advance(POLL);
  await until(() => !hold);
  await sleep(100);
  const ack = await press(s.gladys, 1);
  assert.match(ack.data ?? ack.error, /confirmé/);
  release();
  await reading;
  await sleep(100);
  assert.equal(s.gladys.fake.lastState(F('switch-1:state')), 0);
});
