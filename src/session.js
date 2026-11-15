// -----------------------------------------------------------------------------
// One 2N IP intercom (one address): its readings, its identity, its switches,
// its inputs, its calls, its event channel, and the openings sent to it.
//
// Nothing is sent before the certificate of the address is trusted (pinned):
// without a pin the session only shows the fingerprint it sees.
//
// Readings run one request at a time, in a cycle every `poll_interval`
// (measured from the start of the previous cycle): identity, every 10
// minutes the capabilities of the switches and the inputs, then the switch
// states, the input states and the calls. An endpoint the device refuses or
// lacks never holds the others.
//
// Events (doorbell, switches, inputs, access) come from an event channel of
// the device (/api/log/subscribe, then /api/log/pull waiting up to 20 s), on
// a connection of its own; they update the states at once and make the scene
// events. A channel read answered after a long silence carries old events:
// they are dropped (the next reading gives the states).
//
// A command never waits for a reading: it takes the device at once (the
// reading in flight is aborted, which is not a failure), and a reading that
// left before a command is never applied after it (`epoch`), nor a state
// read before a newer event of the same feature. Commands run one after the
// other per device, each within its own budget counted from its arrival; one
// that could not leave in time says "nothing sent".
//
// An opening is never sent twice by the integration: no retry, no replay
// after a restart. It is decided on the identity read right before it (the
// serial number must be the one of the device the button belongs to), on the
// capabilities of the switch read right before it (enabled, monostable, on
// for 60 s at most: a bistable switch would stay on), and on the option read
// again right before the bytes leave. It is reported confirmed only when the
// switch, inactive before, is read active after it, or when the device
// reports the activation by the API on its event channel.
// -----------------------------------------------------------------------------

import {
  PATHS,
  accessEvent,
  callEvent,
  inputEvent,
  parseAnswer,
  parseChannel,
  parseEvents,
  parseInfo,
  parseIoCaps,
  parseIoStatus,
  parseRinging,
  parseSwitchCaps,
  parseSwitchStatus,
  switchEvent,
} from './api.js';
import { LIMITS, RING_KEY, TRIGGERS, inputKey, switchKey } from './constants.js';
import { IntercomError } from './http.js';
import { T } from './i18n.js';

/** A reading that stepped back (a command came, the session stopped): not a failure. */
class Skip extends Error {}

/** A command refused or failed: its text for the status, its message for Gladys. */
export class CommandError extends Error {
  constructor(text, language) {
    super(text[language === 'en' ? 'en' : 'fr']);
    this.text = text;
  }
}

/** Kinds that say "not allowed / not there" for one endpoint: asked again later, never a refusal. */
const DENIED_KINDS = new Set(['privilege', 'disabled', 'unsupported', 'refused', 'method']);

/** The next wait of an endpoint the device refuses: 1 min, doubled, at most 1 h. */
const nextWait = (wait, timings) =>
  Math.min(timings.forbiddenMax, wait === undefined ? timings.forbiddenFirst : wait * 2);

/** The state of an endpoint other than the identity. */
const endpoint = () => ({ state: 'ok', recheck: 0, wait: undefined, at: undefined });

export class Session {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.digest = {};
    this.state = 'starting';
    this.seen = undefined; // fingerprint seen (no pin, or another certificate)
    this.identity = undefined;
    this.caps = new Map();
    this.switches = new Map();
    this.inputs = [];
    this.inputStates = new Map();
    this.ringing = undefined;
    this.ep = { switches: endpoint(), io: endpoint(), call: endpoint(), events: endpoint() };
    this.epoch = 0;
    this.eventSeq = 0;
    this.lastSeq = new Map();
    this.currentRead = undefined;
    this.timer = undefined;
    this.followTimers = new Set();
    this.stopped = false;
    this.stopController = new AbortController();
    this.failures = 0;
    this.waiting = 0;
    this.commandChain = Promise.resolve();
    this.cmdVerifiedAt = undefined;
    this.cmdCapsAt = undefined;
    this.lastCommand = undefined;
    this.ownOpens = [];
    this.calls = new Map(); // call session -> ringing (true) or ended
    this.lastTest = -Infinity;
    // Event channel.
    this.channel = undefined;
    this.channelAnswerAt = undefined;
    this.listenTimer = undefined;
    this.listening = false;
    this.listenFailures = 0;
  }

  get mono() {
    return this.app.monotonic();
  }

  pins() {
    return this.app.pinsFor(this.host.key);
  }

  // --- lifecycle -----------------------------------------------------------

  begin(delay = 0) {
    if (!this.pins().length) {
      this.setState('untrusted');
      this.showFingerprint();
      return;
    }
    this.schedule(delay);
  }

  /** No pin: the fingerprint seen is shown (a bare handshake, nothing is written). */
  async showFingerprint() {
    try {
      const fp = await this.app.readFingerprint(this.host);
      if (this.stopped) return;
      this.seen = fp;
    } catch {
      if (this.stopped) return;
      this.seen = undefined;
    }
    this.app.refreshStatus();
  }

  schedule(delay) {
    if (this.stopped) return;
    this.app.timers.clearTimeout(this.timer);
    this.timer = this.app.timers.setTimeout(
      () => {
        this.timer = undefined;
        this.cycle().catch((err) =>
          this.app.logger.error(`Reading ${this.host.key} failed`, err?.message),
        );
      },
      Math.max(0, delay),
    );
  }

  stop() {
    this.stopped = true;
    this.app.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.app.timers.clearTimeout(this.listenTimer);
    this.listenTimer = undefined;
    for (const timer of this.followTimers) this.app.timers.clearTimeout(timer);
    this.followTimers.clear();
    this.currentRead?.abort();
    this.stopController.abort();
  }

  setState(state) {
    if (this.stopped) return;
    if (this.state !== state) {
      this.state = state;
      this.app.refreshStatus();
    }
  }

  // --- requests ------------------------------------------------------------

  requestOptions(extra) {
    const { auth, username, password } = this.app.config;
    return {
      host: this.host,
      pins: this.pins(),
      auth: { mode: auth, username, password },
      session: this.digest,
      ...extra,
    };
  }

  /** A reading: steps back for any command, never applied after one. */
  async read(path) {
    if (this.stopped || this.waiting > 0) throw new Skip();
    const epoch = this.epoch;
    const controller = new AbortController();
    this.currentRead = controller;
    try {
      const answer = await this.app.request(
        this.requestOptions({
          path,
          timeout: this.app.timings.readTimeout,
          signal: controller.signal,
        }),
      );
      if (this.stopped || epoch !== this.epoch) throw new Skip();
      return parseAnswer(answer);
    } catch (err) {
      if (err instanceof Skip || this.stopped || epoch !== this.epoch || err?.kind === 'aborted') {
        throw new Skip();
      }
      throw err;
    } finally {
      if (this.currentRead === controller) this.currentRead = undefined;
    }
  }

  /** A request of a command: its own budget, aborted only by a stop. */
  commandRequest(path, timeout, extra = {}) {
    return this.app.request(
      this.requestOptions({ path, timeout, signal: this.stopController.signal, ...extra }),
    );
  }

  // --- readings ------------------------------------------------------------

  async cycle() {
    if (this.stopped) return;
    const started = this.mono;
    let next;
    try {
      await this.readAll();
      this.failures = 0;
      next = started + this.app.config.pollMs - this.mono;
    } catch (err) {
      if (err instanceof Skip) {
        next = started + this.app.config.pollMs - this.mono;
      } else {
        next = this.readFailed(err);
      }
    }
    if (next !== undefined && !this.stopped && this.timer === undefined) this.schedule(next);
  }

  /** A failed reading of the identity: the session stops reading (or waits). */
  readFailed(err) {
    const kind = err?.kind ?? 'answer';
    this.stopListening();
    if (kind === 'refused') {
      this.refused();
      return undefined;
    }
    if (kind === 'nopin') {
      this.setState('untrusted');
      return undefined;
    }
    this.switches.clear();
    this.inputStates.clear();
    this.ringing = undefined;
    if (kind === 'pin') {
      // Another certificate: nothing was sent. Looked at again (a handshake
      // only) after the longest wait; never learnt.
      this.seen = err.fingerprint;
      this.setState('pin');
      return this.app.timings.downMax;
    }
    if (kind === 'basic-only' || kind === 'method' || kind === 'disabled') {
      this.setState(kind === 'basic-only' ? 'basicOnly' : kind);
      return this.app.timings.downMax;
    }
    this.failures += 1;
    this.setState(
      kind === 'answer' || kind === 'unsupported' || kind === 'privilege' ? 'answer' : 'down',
    );
    return Math.min(
      this.app.timings.downMax,
      this.app.config.pollMs * 2 ** Math.min(this.failures - 1, 10),
    );
  }

  refused() {
    this.app.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.stopListening();
    this.switches.clear();
    this.inputStates.clear();
    this.ringing = undefined;
    this.setState('refused');
    this.app.credentialsRefused(this);
  }

  async readAll() {
    const info = parseInfo(await this.read(PATHS.info));
    this.applyIdentity(info);
    this.app.credentialsAccepted(this);
    this.seen = undefined;
    this.setState('ok');
    this.startListening();
    await this.readSwitches();
    await this.readInputs();
    await this.readCall();
  }

  /**
   * One endpoint other than the identity: `fn` reads it; refused or missing,
   * it is "not read" and asked again later (1 min doubled, at most 1 h); a
   * failure is tried again at the next cycle. -> true when read.
   */
  async secondary(name, fn) {
    const ep = this.ep[name];
    if (ep.recheck > this.mono) return false;
    try {
      await fn();
    } catch (err) {
      if (err instanceof Skip) throw err;
      const state = DENIED_KINDS.has(err?.kind) ? 'denied' : 'failed';
      if (state === 'denied') {
        ep.wait = nextWait(ep.wait, this.app.timings);
        ep.recheck = this.mono + ep.wait;
      }
      if (ep.state !== state) {
        ep.state = state;
        this.app.refreshStatus();
      }
      return false;
    }
    ep.wait = undefined;
    if (ep.state !== 'ok') {
      ep.state = 'ok';
      this.app.refreshStatus();
    }
    return true;
  }

  capsDue(at) {
    return at === undefined || this.mono - at > this.app.timings.capsEvery;
  }

  async readSwitches() {
    await this.secondary('switches', async () => {
      if (this.capsDue(this.ep.switches.at)) {
        this.applyCaps(parseSwitchCaps(await this.read(PATHS.switchCaps)));
        this.ep.switches.at = this.mono;
      }
      const seq = this.eventSeq;
      this.applySwitches(parseSwitchStatus(await this.read(PATHS.switchStatus)), seq);
    });
  }

  async readInputs() {
    await this.secondary('io', async () => {
      if (this.capsDue(this.ep.io.at)) {
        const inputs = parseIoCaps(await this.read(PATHS.ioCaps));
        this.ep.io.at = this.mono;
        if (inputs.join() !== this.inputs.join()) {
          this.inputs = inputs;
          this.app.devicesChanged();
        }
      }
      if (!this.inputs.length) return;
      const seq = this.eventSeq;
      const states = parseIoStatus(await this.read(PATHS.ioStatus));
      for (const port of this.inputs) {
        const state = states.get(port);
        if (state === undefined || !this.fresher(inputKey(port), seq)) continue;
        this.inputStates.set(port, state);
        this.app.publishState(this, inputKey(port), state);
      }
    });
  }

  async readCall() {
    await this.secondary('call', async () => {
      const seq = this.eventSeq;
      const ringing = parseRinging(await this.read(PATHS.call));
      if (!this.fresher(RING_KEY, seq)) return;
      if (!ringing) this.calls.clear();
      this.setRinging(ringing);
    });
  }

  /** A state read when the event counter was `seq`: applied unless a newer event of it came. */
  fresher(key, seq) {
    return (this.lastSeq.get(key) ?? 0) <= seq;
  }

  applyIdentity(info) {
    if (this.identity && this.identity.serial !== info.serial) {
      // Another device at this address: nothing of the previous one is kept.
      this.app.logger.warn(`Another device answers at ${this.host.key}`);
      this.caps.clear();
      this.switches.clear();
      this.inputs = [];
      this.inputStates.clear();
      this.ringing = undefined;
      this.calls.clear();
      this.ownOpens = [];
      this.cmdVerifiedAt = undefined;
      this.cmdCapsAt = undefined;
      this.ep.switches.at = undefined;
      this.ep.io.at = undefined;
      this.stopListening();
    }
    const changed =
      !this.identity ||
      this.identity.serial !== info.serial ||
      this.identity.model !== info.model ||
      this.identity.firmware !== info.firmware ||
      this.identity.name !== info.name;
    this.identity = info;
    if (changed) this.app.devicesChanged();
  }

  applyCaps(caps) {
    const enabled = (c) =>
      [...c]
        .filter(([, s]) => s.enabled)
        .map(([n, s]) => `${n}${s.mode}`)
        .join();
    const before = enabled(this.caps);
    this.caps = caps;
    if (enabled(caps) !== before) {
      this.app.devicesChanged();
      this.app.refreshStatus();
    }
  }

  /** The switches the integration shows: enabled in the device. */
  enabledSwitches() {
    return [...this.caps].filter(([, c]) => c.enabled).map(([n]) => n);
  }

  applySwitches(switches, seq) {
    this.switches = switches;
    for (const n of this.enabledSwitches()) {
      const active = switches.get(n)?.active;
      if (active === undefined || !this.fresher(switchKey(n, 'state'), seq)) continue;
      this.app.publishState(this, switchKey(n, 'state'), active ? 0 : 1);
    }
  }

  setRinging(ringing) {
    this.ringing = ringing;
    this.app.publishState(this, RING_KEY, ringing ? 1 : 0);
  }

  // --- event channel ---------------------------------------------------------

  startListening() {
    if (this.listening || this.stopped) return;
    this.listening = true;
    this.listenFailures = 0;
    this.scheduleListen(0);
  }

  stopListening() {
    this.listening = false;
    this.app.timers.clearTimeout(this.listenTimer);
    this.listenTimer = undefined;
    this.channel = undefined;
  }

  scheduleListen(delay) {
    if (this.stopped || !this.listening) return;
    this.app.timers.clearTimeout(this.listenTimer);
    this.listenTimer = this.app.timers.setTimeout(
      () => {
        this.listenTimer = undefined;
        this.listen().catch((err) =>
          this.app.logger.error(`Events of ${this.host.key} failed`, err?.message),
        );
      },
      Math.max(0, delay),
    );
  }

  /** One step of the channel: subscribe when there is none, else one read. */
  async listen() {
    if (this.stopped || !this.listening) return;
    const ep = this.ep.events;
    if (ep.recheck > this.mono) {
      this.scheduleListen(ep.recheck - this.mono);
      return;
    }
    const serial = this.identity?.serial;
    let pause = 0;
    try {
      if (this.channel === undefined) {
        const answer = await this.app.request(
          this.requestOptions({
            path: PATHS.subscribe(),
            timeout: this.app.timings.readTimeout,
            signal: this.stopController.signal,
          }),
        );
        if (this.stopped || !this.listening || serial !== this.identity?.serial) return;
        this.channel = parseChannel(parseAnswer(answer));
        this.channelAnswerAt = this.mono;
      } else {
        const channel = this.channel;
        const sentAt = this.mono;
        const answer = await this.app.request(
          this.requestOptions({
            path: PATHS.pull(channel),
            timeout: this.app.timings.pullSeconds * 1000 + this.app.timings.readTimeout,
            signal: this.stopController.signal,
          }),
        );
        if (this.stopped || !this.listening || channel !== this.channel) return;
        const { events, dropped } = parseEvents(parseAnswer(answer));
        const mono = this.mono;
        // A device that answers at once without an event is not read in a
        // tight loop: 1 s between two such reads.
        if (!events.length && mono - sentAt < 1000) pause = 1000;
        this.listenFailures = 0;
        const silence = mono - this.channelAnswerAt;
        this.channelAnswerAt = mono;
        if (silence > this.app.timings.eventGap || silence < 0) {
          if (events.length) {
            this.app.logger.warn(
              `${events.length} old events of ${this.host.key} not published (late read)`,
            );
          }
        } else {
          if (dropped) {
            this.app.logger.warn(
              `${dropped} events of ${this.host.key} not published (too many at once)`,
            );
          }
          if (serial === this.identity?.serial) for (const e of events) this.onEvent(e);
        }
      }
    } catch (err) {
      if (this.stopped || !this.listening) return;
      this.channel = undefined;
      if (err?.kind === 'aborted') return;
      if (DENIED_KINDS.has(err?.kind) || err?.kind === 'answer') {
        // An unknown or expired channel answers an "invalid parameter" error:
        // subscribed again at once, once; anything else waits.
        if (err?.kind === 'answer' && err.code !== undefined && this.listenFailures === 0) {
          this.listenFailures = 1;
          this.scheduleListen(0);
          return;
        }
      }
      if (DENIED_KINDS.has(err?.kind)) {
        ep.wait = nextWait(ep.wait, this.app.timings);
        ep.recheck = this.mono + ep.wait;
        this.setEventsState('denied');
        this.scheduleListen(ep.wait);
        return;
      }
      this.listenFailures += 1;
      this.setEventsState('failed');
      this.scheduleListen(
        Math.min(
          this.app.timings.downMax,
          this.app.config.pollMs * 2 ** Math.min(this.listenFailures - 1, 10),
        ),
      );
      return;
    }
    ep.wait = undefined;
    this.setEventsState('ok');
    this.scheduleListen(pause);
  }

  setEventsState(state) {
    if (this.ep.events.state !== state) {
      this.ep.events.state = state;
      this.app.refreshStatus();
    }
  }

  bump(key) {
    this.eventSeq += 1;
    this.lastSeq.set(key, this.eventSeq);
  }

  onEvent({ event, params }) {
    const device = this.app.deviceId(this.identity.serial);
    if (event === 'SwitchStateChanged') {
      const e = switchEvent(params);
      if (!e) return;
      const key = switchKey(e.n, 'state');
      this.bump(key);
      const current = this.switches.get(e.n) ?? {};
      this.switches.set(e.n, { ...current, active: e.active });
      if (this.caps.get(e.n)?.enabled) this.app.publishState(this, key, e.active ? 0 : 1);
      if (!e.active) return;
      const own = e.originator === 'api' ? this.consumeOwnOpen(e.n) : undefined;
      if (own) {
        // Confirms the opening only when the switch was read inactive before it.
        if (own.before === false) {
          own.confirmed = true;
          this.commandConfirmed(e.n);
        }
        return;
      }
      this.app.sceneEvent(TRIGGERS.SWITCH, {
        device,
        switch: String(e.n),
        originator: e.originator,
      });
    } else if (event === 'InputChanged') {
      const e = inputEvent(params);
      if (!e || !this.inputs.includes(e.port)) return;
      this.bump(inputKey(e.port));
      this.inputStates.set(e.port, e.state);
      this.app.publishState(this, inputKey(e.port), e.state);
    } else if (event === 'CallStateChanged') {
      const e = callEvent(params);
      if (!e) return;
      const id = e.session ?? 'unknown';
      const ringingNow = e.direction === 'outgoing' && ['connecting', 'ringing'].includes(e.state);
      const known = this.calls.has(id);
      if (ringingNow) {
        this.calls.set(id, true);
        if (!known) this.app.sceneEvent(TRIGGERS.DOORBELL, { device });
      } else if (known || e.direction === 'outgoing') {
        this.calls.set(id, false);
      }
      while (this.calls.size > LIMITS.calls) this.calls.delete(this.calls.keys().next().value);
      this.bump(RING_KEY);
      this.setRinging([...this.calls.values()].some(Boolean));
    } else if (event === 'UserAuthenticated' || event === 'UserRejected') {
      const rejected = event === 'UserRejected';
      this.app.sceneEvent(rejected ? TRIGGERS.DENIED : TRIGGERS.GRANTED, {
        device,
        ...accessEvent(params, rejected),
      });
    }
  }

  /**
   * The activation an opening from Gladys made is not an event (a scene
   * opening the door on "switch activated" would loop): one activation by
   * the API per opening, on its switch, within 30 s of its first byte. The
   * mark is set before that byte, so the event may come before the answer.
   * -> the mark, or undefined.
   */
  consumeOwnOpen(n) {
    const mono = this.mono;
    this.ownOpens = this.ownOpens.filter((o) => mono - o.at <= this.app.timings.ownOpenMax);
    const index = this.ownOpens.findIndex((o) => o.n === n);
    if (index === -1) return undefined;
    const [mark] = this.ownOpens.splice(index, 1);
    return mark;
  }

  markOwnOpen(n, at, before) {
    const mark = { n, at, before, confirmed: false };
    this.ownOpens.push(mark);
    if (this.ownOpens.length > LIMITS.ownOpens) this.ownOpens.shift();
    return mark;
  }

  commandConfirmed(n) {
    const text = T.confirmed(n);
    if (this.lastCommand?.en !== text.en) {
      this.lastCommand = text;
      this.app.refreshStatus();
    }
  }

  // --- commands ------------------------------------------------------------

  async open(n, received) {
    const language = this.app.config.language;
    const refuse = (reason) => {
      throw new CommandError(T.notSent(n, reason), language);
    };
    if (!this.app.config.allowOpen) refuse(T.openDisabled);
    if (this.state === 'refused') refuse(T.credentialsRefused);
    if (!this.pins().length) refuse(T.untrustedReason);
    if (this.waiting >= LIMITS.commandQueue) refuse(T.queueFull);
    const deadline = received + this.app.timings.commandBudget;
    this.waiting += 1;
    this.epoch += 1;
    this.currentRead?.abort();
    const run = this.commandChain.then(() => this.runOpen(n, deadline, received));
    this.commandChain = run.catch(() => {});
    try {
      return await run;
    } catch (err) {
      if (err instanceof CommandError) {
        this.lastCommand = err.text;
        this.app.refreshStatus();
        this.app.logger.info(`Opening ${this.host.key} switch ${n}: ${err.text.en}`);
      }
      throw err;
    } finally {
      this.waiting -= 1;
      if (this.waiting === 0 && !this.stopped && this.timer === undefined && this.state === 'ok') {
        // The cycle a command stopped is read again at its normal time.
        this.schedule(this.app.config.pollMs);
      }
    }
  }

  async runOpen(n, deadline, received) {
    const language = this.app.config.language;
    const fail = (text) => {
      throw new CommandError(text, language);
    };
    const notSent = (reason) => fail(T.notSent(n, reason));
    const remaining = () => deadline - this.mono;
    const step = () => Math.min(this.app.timings.commandStepTimeout, remaining());
    if (this.stopped) notSent(T.stopped);
    if (!this.app.config.allowOpen) notSent(T.openDisabled);
    if (this.state === 'refused') notSent(T.credentialsRefused);
    if (!this.identity) notSent(T.unknownDevice);
    if (remaining() < 100) notSent(T.tooLate);
    const reasonOf = (err) => {
      if (err?.kind === 'refused') return T.refusedReason;
      if (err?.kind === 'withdrawn') return err.reason ?? T.openDisabled;
      if (err?.kind === 'aborted') return T.stopped;
      if (err?.kind === 'nopin') return T.untrustedReason;
      if (err?.kind === 'pin') return T.pinReason;
      if (err?.kind === 'privilege') return T.privilegeReason;
      if (err?.kind === 'disabled') return T.disabledReason;
      if (err?.kind === 'basic-only' || err?.kind === 'method') return T.methodReason;
      if (err?.kind === 'answer' && err.sent) return T.unexpectedReason;
      return T.unreachable;
    };

    // 1. Identity, read right before (shared with a command that read it after
    // this one arrived).
    if (this.cmdVerifiedAt === undefined || this.cmdVerifiedAt < received) {
      let info;
      try {
        info = parseInfo(parseAnswer(await this.commandRequest(PATHS.info, step())));
      } catch (err) {
        if (err?.kind === 'refused') this.refused();
        notSent(reasonOf(err));
      }
      if (info.serial !== this.identity.serial) notSent(T.otherDevice);
      this.cmdVerifiedAt = this.mono;
    }

    // 2. The capabilities of the switch, read right before (shared with a
    // command that read them after this one arrived): enabled, monostable
    // (a trigger turns a bistable switch on for good), on for 60 s at most.
    if (this.cmdCapsAt === undefined || this.cmdCapsAt < received) {
      if (remaining() < 100) notSent(T.tooLate);
      let caps;
      try {
        caps = parseSwitchCaps(parseAnswer(await this.commandRequest(PATHS.switchCaps, step())));
      } catch (err) {
        notSent(reasonOf(err));
      }
      this.applyCaps(caps);
      this.cmdCapsAt = this.mono;
    }
    const caps = this.caps.get(n);
    if (!caps) notSent(T.unknownSwitch);
    if (!caps.enabled) notSent(T.switchDisabled);
    if (caps.mode === 'bistable') notSent(T.bistable);
    if (caps.mode !== 'monostable') notSent(T.modeUnknown);
    if (caps.duration === undefined || caps.duration < 1) notSent(T.modeUnknown);
    if (caps.duration > LIMITS.maxSwitchOnSeconds) {
      notSent(T.tooLong(caps.duration, LIMITS.maxSwitchOnSeconds));
    }
    // The state of the switch, read right before (never the one in memory):
    // a switch already active is never reported confirmed. Optional: read
    // only when the budget leaves the trigger its own time after it (a slow
    // intercom loses the confirmation, never the opening); unread or
    // unreadable, the opening can only be reported "accepted".
    if (remaining() < 100) notSent(T.tooLate);
    let before;
    if (remaining() > this.app.timings.beforeReadMin) {
      try {
        const budget = Math.min(step(), remaining() - this.app.timings.triggerReserve);
        const status = parseSwitchStatus(
          parseAnswer(await this.commandRequest(PATHS.switchStatusOf(n), budget)),
        );
        before = status.get(n)?.active;
      } catch (err) {
        if (err?.kind === 'aborted') notSent(T.stopped);
        before = undefined;
      }
    }
    if (remaining() < 100) notSent(T.tooLate);

    // 3. The trigger: the switch turns off by itself after its duration. The
    // mark of this opening is set right before the first byte (the device may
    // report the activation on the event channel before the answer comes),
    // and taken back when nothing left or the device refused.
    let mark;
    const unmark = () => {
      this.ownOpens = this.ownOpens.filter((o) => o !== mark);
    };
    let answer;
    try {
      answer = await this.commandRequest(PATHS.trigger(n), step(), {
        beforeSend: () => {
          // Read again right before the bytes leave.
          if (this.stopped) {
            return Object.assign(new IntercomError('Stopped', 'withdrawn'), { reason: T.stopped });
          }
          if (!this.app.config.allowOpen) {
            return Object.assign(new IntercomError('Option off', 'withdrawn'), {
              reason: T.openDisabled,
            });
          }
          if (this.mono >= deadline) {
            return Object.assign(new IntercomError('Too late', 'withdrawn'), { reason: T.tooLate });
          }
          if (!mark) mark = this.markOwnOpen(n, this.mono, before);
          return true;
        },
      });
    } catch (err) {
      // A 401 here is reported, never taken for refused credentials (the
      // identity, read just before, is where credentials are judged).
      if (!err?.sent) {
        unmark();
        notSent(reasonOf(err));
      }
      this.followUp(n, before);
      this.app.logger.info(`Opening ${this.host.key} switch ${n}: sent, no answer`);
      fail(T.sentUnconfirmed(n));
    }
    try {
      parseAnswer(answer);
    } catch (err) {
      unmark();
      if (err?.kind === 'privilege') fail(T.notSent(n, T.privilegeReason));
      if (err?.kind === 'disabled') fail(T.notSent(n, T.disabledReason));
      fail(T.rejectedByDevice(n));
    }
    this.app.logger.info(`Opening ${this.host.key} switch ${n}: accepted by the device`);

    // 4. Read back: confirmed only when active after being read inactive
    // right before, or when the device reported this activation by the API.
    if (!mark.confirmed && remaining() > 150) {
      try {
        const seq = this.eventSeq;
        const status = parseSwitchStatus(
          parseAnswer(await this.commandRequest(PATHS.switchStatusOf(n), step())),
        );
        const active = status.get(n)?.active;
        if (active !== undefined && this.fresher(switchKey(n, 'state'), seq)) {
          this.switches.set(n, { ...(this.switches.get(n) ?? {}), ...status.get(n) });
          if (this.caps.get(n)?.enabled) {
            this.app.publishState(this, switchKey(n, 'state'), active ? 0 : 1);
          }
        }
        if (before === false && active === true) mark.confirmed = true;
      } catch {
        // Read back later.
      }
    }
    if (mark.confirmed) {
      this.lastCommand = T.confirmed(n);
      this.app.refreshStatus();
      return this.lastCommand;
    }
    this.followUp(n, before);
    fail(T.acceptedUnconfirmed(n));
  }

  /** Reads the switch again after an opening, to confirm it in the status. */
  followUp(n, before) {
    for (const delay of this.app.timings.confirmReads) {
      const timer = this.app.timers.setTimeout(async () => {
        this.followTimers.delete(timer);
        try {
          const seq = this.eventSeq;
          const status = parseSwitchStatus(await this.read(PATHS.switchStatusOf(n)));
          const active = status.get(n)?.active;
          if (active === undefined || !this.fresher(switchKey(n, 'state'), seq)) return;
          if (this.caps.get(n)?.enabled) {
            this.app.publishState(this, switchKey(n, 'state'), active ? 0 : 1);
          }
          if (before === false && active === true) this.commandConfirmed(n);
        } catch {
          // The next cycle reads it.
        }
      }, delay);
      this.followTimers.add(timer);
    }
  }

  // --- test button -----------------------------------------------------------

  async test() {
    const mono = this.mono;
    if (mono - this.lastTest < this.app.timings.testEvery && mono >= this.lastTest) {
      return T.testTooSoon(this.host.key);
    }
    this.lastTest = mono;
    if (!this.pins().length) {
      await this.showFingerprint();
      return this.seen ? T.untrusted(this.host.key, this.seen) : T.down(this.host.key);
    }
    try {
      const answer = await this.app.request(
        this.requestOptions({
          path: PATHS.info,
          timeout: this.app.timings.readTimeout,
          signal: this.stopController.signal,
        }),
      );
      const info = parseInfo(parseAnswer(answer));
      this.app.credentialsAccepted(this);
      if (this.state !== 'ok' || !this.identity) {
        this.failures = 0;
        this.state = 'starting';
        this.schedule(0);
      }
      return T.testOk(this.host.key, info.model, info.serial.toUpperCase());
    } catch (err) {
      if (err?.kind === 'refused') {
        this.refused();
        return T.refused(this.host.key);
      }
      if (err?.kind === 'pin') {
        this.seen = err.fingerprint;
        this.setState('pin');
        return T.pin(this.host.key, err.fingerprint);
      }
      if (err?.kind === 'basic-only' || err?.kind === 'method') return T.method(this.host.key);
      if (err?.kind === 'disabled') return T.disabled(this.host.key);
      if (err?.kind === 'answer' || err?.kind === 'unsupported' || err?.kind === 'privilege') {
        return T.answer(this.host.key);
      }
      return T.down(this.host.key);
    }
  }
}
