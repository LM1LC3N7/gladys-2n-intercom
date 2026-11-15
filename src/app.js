// -----------------------------------------------------------------------------
// IntercomApp: the configuration, one Session per address (src/session.js),
// the certificates trusted per address, Discovery, the states and scene events
// published to Gladys under their rate limits, the status of the
// Configuration screen, what is kept in /data (src/store.js).
//
// Clocks are injected: `monotonic` for every decision (deadlines, intervals,
// windows, limits), `now` for /data dates only; `timers` for every timer.
// -----------------------------------------------------------------------------

import { performance } from 'node:perf_hooks';
import { normalizeConfig } from './config.js';
import { DEVICE_TYPE, LIMITS, TIMINGS } from './constants.js';
import { buildDevice, parseFeatureId } from './devices.js';
import { RateLimiter } from './events.js';
import { request as httpRequest, readFingerprint } from './http.js';
import { T } from './i18n.js';
import { CommandError, Session } from './session.js';
import { FileStore, emptyData, fingerprint } from './store.js';

const credentialsOf = (config) => `${config.auth}\n${config.username}\n${config.password}`;

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

export class IntercomApp {
  constructor({
    gladys,
    logger = console,
    store = new FileStore(),
    timers = globalThis,
    now = Date.now,
    monotonic = () => performance.now(),
    timings = {},
    request = httpRequest,
    fingerprintOf = readFingerprint,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.timers = timers;
    this.now = now;
    this.monotonic = monotonic;
    this.timings = { ...TIMINGS, ...timings };
    this.request = request;
    this.fingerprintOf = fingerprintOf;
    this.sessions = new Map();
    this.config = undefined;
    this.data = undefined;
    this.storeState = undefined;
    this.chain = Promise.resolve();
    this.stopped = false;
    this.lastStatus = undefined;
    this.statusQueued = false;
    this.discoveryQueued = false;
    this.published = new Map();
    this.pendingTrust = undefined;
    this.stateLimiter = new RateLimiter(LIMITS.statesPerMinute);
    this.eventLimiter = new RateLimiter(LIMITS.eventsPerMinute);
  }

  // --- lifecycle -------------------------------------------------------------

  /** A configuration (start, save, reconnection): applied one at a time, the last one wins. */
  start(raw, { saved = false } = {}) {
    const run = this.chain.then(() => this.apply(raw, saved));
    this.chain = run.catch(() => {});
    return run;
  }

  async loadData() {
    if (this.data) return;
    const { data, state } = await this.store.load();
    if (this.data) return;
    this.data = data ?? emptyData();
    this.storeState = state;
  }

  async apply(raw, saved = false) {
    if (this.stopped) return;
    await this.loadData();
    if (this.stopped) return;
    const next = normalizeConfig(raw);
    const previous = this.config;
    this.config = next;
    const credentialsChanged = previous && credentialsOf(previous) !== credentialsOf(next);
    const pinsChanged = previous && previous.fingerprints.join() !== next.fingerprints.join();
    if ((credentialsChanged || saved) && Object.keys(this.data.refused).length) {
      // New credentials, or the configuration saved by the user (a changed
      // password may share the 8-bit fingerprint of the refused one): tried
      // again everywhere, once.
      this.data.refused = {};
      this.persist();
    }
    this.restart(credentialsChanged || pinsChanged);
    // Fresh states only: what Gladys had is published again from the next readings.
    this.published.clear();
    this.gladys.forgetPublishedStates?.();
    this.lastStatus = undefined;
    this.refreshStatus();
    // Never awaited: a slow Discovery never holds the next configuration (an
    // option unchecked meanwhile applies at once).
    this.scan();
  }

  /** The sessions of the configured addresses; `all`: every one started again. */
  restart(all, keys = []) {
    const next = this.config;
    const wanted = new Map(
      next.problem && next.problem !== 'tooManyHosts' ? [] : next.hosts.map((h) => [h.key, h]),
    );
    for (const [key, session] of this.sessions) {
      if (!wanted.has(key) || all || keys.includes(key)) {
        session.stop();
        this.sessions.delete(key);
      }
    }
    for (const [key, host] of wanted) {
      const existing = this.sessions.get(key);
      if (existing) {
        // A refusal lifted by this configuration: tried again, once.
        if (existing.state === 'refused' && !this.isRefused(existing)) {
          existing.state = 'starting';
          existing.begin(0);
        }
        continue;
      }
      const session = new Session(this, host);
      this.sessions.set(key, session);
      if (this.isRefused(session)) session.state = 'refused';
      else session.begin(0);
    }
  }

  async stop() {
    this.stopped = true;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }

  // --- certificates ------------------------------------------------------------

  /** The fingerprints trusted for an address: the typed ones, and the one pinned in /data. */
  pinsFor(key) {
    const pinned = this.data?.pins[key];
    const typed = this.config?.fingerprints ?? [];
    return pinned && !typed.includes(pinned) ? [...typed, pinned] : [...typed];
  }

  readFingerprint(host) {
    return this.fingerprintOf(host, this.timings.connectTimeout);
  }

  /**
   * "Trust the certificates", in two clicks: the first reads the certificate
   * of every address not trusted yet (or showing another one) and lists their
   * fingerprints, nothing else is sent; the second, within 2 minutes, pins
   * every one that shows the same fingerprint again, kept in /data (written
   * before anything is sent; not written, not trusted).
   */
  async trustCertificates() {
    if (this.stopped) return T.trust.none;
    if (!this.config) return T.configLoading;
    if (this.config.problem && this.config.problem !== 'tooManyHosts') {
      return T[this.config.problem];
    }
    const targets = [...this.sessions.values()].filter(
      (s) => !s.pins().length || s.state === 'pin',
    );
    if (!targets.length) return T.trust.none;
    const seen = await Promise.all(
      targets.map(async (s) => {
        try {
          return { session: s, fp: await this.readFingerprint(s.host) };
        } catch {
          return { session: s, fp: undefined };
        }
      }),
    );
    if (this.stopped) return T.trust.none;
    const mono = this.monotonic();
    const pending = this.pendingTrust;
    const confirmable =
      pending && mono - pending.at <= this.timings.trustWindow && mono >= pending.at;
    const toPin = confirmable
      ? seen.filter((x) => x.fp && pending.fps.get(x.session.host.key) === x.fp)
      : [];
    if (!toPin.length) {
      const readable = seen.filter((x) => x.fp);
      this.pendingTrust = readable.length
        ? { at: mono, fps: new Map(readable.map((x) => [x.session.host.key, x.fp])) }
        : undefined;
      return T.trust.confirm(seen.map((x) => ({ host: x.session.host.key, fp: x.fp })));
    }
    this.pendingTrust = undefined;
    if (this.storeState === 'unreadable') return T.trust.notKept;
    const before = { ...this.data.pins };
    for (const { session, fp } of toPin) this.data.pins[session.host.key] = fp;
    let ok;
    try {
      ok =
        (await withTimeout(this.store.save(structuredClone(this.data)), TIMINGS.storeTimeout)) !==
        false;
    } catch {
      ok = false;
    }
    if (!ok) {
      this.data.pins = before;
      return T.trust.notKept;
    }
    if (this.stopped) return T.trust.none;
    const keys = toPin.map((x) => x.session.host.key);
    this.logger.info(`Certificate trusted (two clicks) for ${keys.join(', ')}`);
    this.restart(false, keys);
    this.refreshStatus();
    return T.trust.done(toPin.map((x) => ({ host: x.session.host.key, fp: x.fp })));
  }

  // --- refused credentials (/data) --------------------------------------------

  credentialMark(session) {
    return fingerprint(this.data.salt, session.host.key, this.config);
  }

  isRefused(session) {
    return this.data.refused[session.host.key]?.fp === this.credentialMark(session);
  }

  credentialsRefused(session) {
    if (this.stopped || this.sessions.get(session.host.key) !== session) return;
    this.logger.warn(
      `Credentials refused by ${session.host.key}: no more tries until changed or tested`,
    );
    this.data.refused[session.host.key] = { fp: this.credentialMark(session), at: this.now() };
    this.persist();
  }

  credentialsAccepted(session) {
    if (this.stopped || !this.data.refused[session.host.key]) return;
    if (this.sessions.get(session.host.key) !== session) return;
    delete this.data.refused[session.host.key];
    this.persist();
  }

  /** Never awaited: a slow disk holds nothing. An unreadable file is never overwritten. */
  persist() {
    if (this.storeState === 'unreadable') return;
    Promise.resolve(this.store.save(structuredClone(this.data))).then(
      (ok) => {
        if (ok === false) this.logger.warn('/data could not be written');
      },
      () => this.logger.warn('/data could not be written'),
    );
  }

  // --- Gladys ------------------------------------------------------------------

  deviceId(serial) {
    return this.gladys.externalIds(DEVICE_TYPE, serial).device;
  }

  /** The devices read in this session, as Discovery shows them. */
  async scan() {
    if (this.stopped || !this.config) return;
    const devices = [];
    for (const session of this.sessions.values()) {
      if (!session.identity) continue;
      const { serial, model, firmware, name } = session.identity;
      const existing = (this.gladys.devices ?? []).find(
        (d) => d.external_id === this.deviceId(serial),
      );
      devices.push(
        buildDevice(
          this.gladys,
          {
            serial,
            model,
            firmware,
            name,
            host: session.host.key,
            switches: session.enabledSwitches(),
            inputs: session.inputs,
          },
          this.config.language,
          existing,
        ),
      );
    }
    // The same device behind two addresses is listed once.
    const unique = [...new Map(devices.map((d) => [d.external_id, d])).values()];
    try {
      await this.gladys.publishDiscoveredDevices(unique);
    } catch (err) {
      this.logger.warn('Discovery not published', err?.message);
    }
  }

  devicesChanged() {
    if (this.discoveryQueued) return;
    this.discoveryQueued = true;
    queueMicrotask(() => {
      this.discoveryQueued = false;
      this.scan();
    });
  }

  async deviceCreated(device) {
    // Its states are published again from the next reading (never a cached value).
    for (const key of [...this.published.keys()]) {
      if (key.startsWith(`${device?.external_id}:`)) this.published.delete(key);
    }
  }

  async deviceDeleted(device) {
    await this.deviceCreated(device);
  }

  publishState(session, key, value) {
    if (this.stopped || this.sessions.get(session.host.key) !== session || !session.identity) {
      return;
    }
    const id = this.gladys.externalIds(DEVICE_TYPE, session.identity.serial).feature(key);
    if (this.published.get(id) === value) return;
    if (!this.stateLimiter.take(this.monotonic())) return;
    this.published.set(id, value);
    this.gladys
      .publishChangedStates([{ device_feature_external_id: id, state: value }])
      .catch((err) => {
        this.published.delete(id);
        this.logger.warn('State not published', err?.message);
      });
  }

  sceneEvent(key, data) {
    if (this.stopped) return;
    if (!this.eventLimiter.take(this.monotonic())) {
      this.logger.warn(
        `Event ${key} not published: more than ${LIMITS.eventsPerMinute} per minute`,
      );
      return;
    }
    this.gladys
      .publishSceneEvent(key, data)
      .catch((err) => this.logger.warn(`Event ${key} not published`, err?.message));
  }

  // --- commands ----------------------------------------------------------------

  async setValue(_device, feature, value) {
    const received = this.monotonic();
    const language = this.config?.language;
    const refuse = (reason) => {
      throw new CommandError(reason, language);
    };
    if (!this.config) refuse(T.configLoading);
    const target = parseFeatureId(this.gladys, feature?.external_id);
    if (!target) refuse(T.unknownDevice);
    if (target.kind !== 'open') refuse(T.notButton);
    if (value !== 1 && value !== '1') refuse(T.badValue);
    const session = [...this.sessions.values()].find((s) => s.identity?.serial === target.serial);
    if (!session) refuse(T.unknownDevice);
    const text = await session.open(target.n, received);
    return text[language === 'en' ? 'en' : 'fr'];
  }

  /** The test button: every address once (each at most every 5 s). */
  async testConnection() {
    if (!this.config) return T.configLoading;
    if (this.config.problem && this.config.problem !== 'tooManyHosts') {
      return T[this.config.problem];
    }
    const results = await Promise.all([...this.sessions.values()].map((s) => s.test()));
    this.refreshStatus();
    if (!results.length) return T.testNoHost;
    return {
      fr: results.map((r) => r.fr).join(' · '),
      en: results.map((r) => r.en).join(' · '),
    };
  }

  // --- status ------------------------------------------------------------------

  statusLine(session) {
    const key = session.host.key;
    switch (session.state) {
      case 'ok': {
        const line = T.ok(key, session.identity?.model ?? '2N', session.enabledSwitches().length);
        const extras = [];
        const names = {
          switches: T.epSwitches,
          io: T.epInputs,
          call: T.epCalls,
          events: T.epEvents,
        };
        for (const [name, ep] of Object.entries(session.ep)) {
          if (ep.state === 'denied') extras.push(T.notAllowed(names[name]));
          else if (ep.state === 'failed') extras.push(T.notRead(names[name]));
        }
        if (session.lastCommand) extras.push(T.lastCommand(session.lastCommand));
        if (!extras.length) return line;
        return {
          fr: `${line.fr} (${extras.map((e) => e.fr).join(', ')})`,
          en: `${line.en} (${extras.map((e) => e.en).join(', ')})`,
        };
      }
      case 'untrusted':
        return session.seen ? T.untrusted(key, session.seen) : T.untrustedUnread(key);
      case 'pin':
        return T.pin(key, session.seen);
      case 'refused':
        return T.refused(key);
      case 'basicOnly':
      case 'method':
        return T.method(key);
      case 'disabled':
        return T.disabled(key);
      case 'answer':
        return T.answer(key);
      case 'down':
        return T.down(key);
      default:
        return T.starting(key);
    }
  }

  refreshStatus() {
    if (this.statusQueued) return;
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      this.publishStatus();
    });
  }

  publishStatus() {
    if (this.stopped || !this.config) return;
    const config = this.config;
    let connected = false;
    let parts = [];
    if (config.problem && config.problem !== 'tooManyHosts') {
      parts.push(T[config.problem]);
    } else {
      if (config.problem) parts.push(T[config.problem]);
      for (const session of this.sessions.values()) {
        if (session.state === 'ok') connected = true;
        parts.push(this.statusLine(session));
      }
      if (!config.allowOpen) parts.push(T.openOff);
    }
    if (config.invalid) parts.push(T.ignored(config.invalid));
    if (config.badFingerprints) parts.push(T.badFingerprints(config.badFingerprints));
    if (this.storeState === 'unreadable') parts.push(T.dataUnreadable);
    parts = parts.filter(Boolean);
    const cut = (text) =>
      text.length > LIMITS.status ? `${text.slice(0, LIMITS.status - 1)}…` : text;
    const message = {
      fr: cut(parts.map((p) => p.fr).join(' · ')),
      en: cut(parts.map((p) => p.en).join(' · ')),
    };
    const key = `${connected}\n${message.fr}\n${message.en}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.gladys.setConnectionStatus(connected, message).catch(() => {
      this.lastStatus = undefined;
    });
  }
}
