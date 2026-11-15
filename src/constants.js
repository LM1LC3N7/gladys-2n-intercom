// -----------------------------------------------------------------------------
// Keys, timings and limits. Every bound the integration applies lives here.
// -----------------------------------------------------------------------------

/** The manifest actions (Configuration screen buttons). */
export const ACTIONS = Object.freeze({ TEST: 'test_connection', TRUST: 'trust_certificates' });

/** The manifest scene triggers. Keys are forever. */
export const TRIGGERS = Object.freeze({
  DOORBELL: 'doorbell',
  SWITCH: 'switch_activated',
  GRANTED: 'access_granted',
  DENIED: 'access_denied',
});

/** The device type in the external ids: ext:<selector>:2n:<serial>. */
export const DEVICE_TYPE = '2n';

/** Feature keys. Switches 1 to 4; inputs by their port name; the doorbell. */
export const switchKey = (n, kind) => `switch-${n}:${kind}`;
export const inputKey = (port) => `input-${port}:state`;
export const RING_KEY = 'call:ring';
export const FEATURE_RE =
  /^(?:switch-([1-4]):(state|open)|input-([A-Za-z0-9_]{1,32}):state|call:ring)$/;

/** Reading interval (seconds). */
export const POLL = Object.freeze({ min: 5, max: 300, default: 10 });

/** HTTPS port of the device. */
export const DEFAULT_PORT = 443;

export const TIMINGS = Object.freeze({
  /** Budget of one reading request, TLS handshake and Digest exchange included. */
  readTimeout: 5000,
  /** A TLS handshake never takes longer (a reading, or a command step). */
  connectTimeout: 3000,
  /** Budget of one request of a command (identity, switch, trigger). */
  commandStepTimeout: 1500,
  /** A command acks under this (Gladys stops waiting at 5 s). */
  commandBudget: 3300,
  /** After an opening accepted without confirmation, the switch is read again after these. */
  confirmReads: [1000, 3000],
  /** The capabilities of the switches and the inputs are read again after this. */
  capsEvery: 10 * 60_000,
  /** An unreachable device: tried again after interval x 2^n, at most this. */
  downMax: 300_000,
  /** An endpoint the device does not allow (privilege, 403): tried again after this, doubled, at most 1 h. */
  forbiddenFirst: 60_000,
  forbiddenMax: 3_600_000,
  /** Event channel: the device keeps it this long without a read (seconds, 1 to 3600). */
  channelSeconds: 60,
  /** Event channel: a read waits this long for an event (seconds). */
  pullSeconds: 20,
  /** Event channel: a read answered after a longer silence than this carries old events. */
  eventGap: 90_000,
  /** An opening from Gladys: its switch activation is not an event, within this. */
  ownOpenMax: 30_000,
  /** The test button: once per address every this. */
  testEvery: 5000,
  /** "Trust the certificates": the second click must come within this, the same fingerprint seen. */
  trustWindow: 120_000,
  /** getConfig() failed: tried again after these delays (the last one repeats). */
  configRetry: [5000, 15_000, 30_000, 60_000],
  /** /data: a read or a write never waits longer. */
  storeTimeout: 2000,
});

export const LIMITS = Object.freeze({
  /** Addresses in the configuration. */
  hosts: 8,
  /** Switches of a device (2N: 1 to 4). */
  switches: 4,
  /** Inputs of a device kept. */
  inputs: 16,
  /** Fingerprints typed in the configuration. */
  fingerprints: 16,
  /** A monostable switch that stays on longer than this (seconds) is never triggered. */
  maxSwitchOnSeconds: 60,
  /** Size of an answer of the device, cut beyond (bytes). */
  maxBody: 128 * 1024,
  /** Events of one channel read handled; the oldest extra ones are dropped. */
  eventsPerPull: 20,
  /** Calls remembered per device (a doorbell event per call). */
  calls: 32,
  /** Scene events and states per minute, for the whole integration (Gladys: 300). */
  eventsPerMinute: 120,
  statesPerMinute: 250,
  /** Openings from Gladys remembered per device. */
  ownOpens: 8,
  /** Waiting commands per device. */
  commandQueue: 4,
  /** A text of the device (name, model) published at most this long. */
  text: 64,
  /** Connection status message. */
  status: 900,
  /** An action answer (fingerprints listed). */
  actionText: 1500,
  /** /data file. */
  storeBytes: 64 * 1024,
  /** Bits of the fingerprint kept for refused credentials. */
  refusedBits: 8,
});
