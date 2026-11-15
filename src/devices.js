// -----------------------------------------------------------------------------
// 2N IP intercoms -> Gladys devices (pure).
//
// External ids (forever): `ext:<selector>:2n:<serial>` for the device, the
// serial number read from /api/system/info (lower case, e.g. 54-0123-4567);
// its features:
//   - `switch-<n>:state`: lock/state, READ ONLY (1 inactive, 0 active), per
//     switch enabled in the device (1 to 4);
//   - `switch-<n>:open`: button/push, the opening (off by default);
//   - `input-<port>:state`: input/binary, READ ONLY (the digital inputs);
//   - `call:ring`: doorbell/ring, READ ONLY (1 while a visitor's call rings).
// The opening is a push button, never a switch nor a lock: a "turn
// everything off" or a "lock everything" can never activate a door switch.
// There is no closing command: a monostable switch (the only kind this
// integration triggers) turns off by itself after its duration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURE_RE, RING_KEY, inputKey, switchKey } from './constants.js';
import { T as TEXT } from './i18n.js';

const READ_ONLY = { read_only: true, has_feedback: true, keep_history: true };

const SWITCH_STATE = { category: C.LOCK, type: T.LOCK.STATE, min: 0, max: 1, ...READ_ONLY };
const INPUT = { category: C.INPUT, type: T.INPUT.BINARY, min: 0, max: 1, ...READ_ONLY };
const RING = { category: C.DOORBELL, type: T.DOORBELL.RING, min: 0, max: 1, ...READ_ONLY };
const BUTTON = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/**
 * The feature id of a device -> { serial, kind: 'open'|'state'|'input'|'ring',
 * n?, port? }, or undefined.
 */
export function parseFeatureId(gladys, externalId) {
  if (typeof externalId !== 'string') return undefined;
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (!externalId.startsWith(prefix)) return undefined;
  const rest = externalId.slice(prefix.length);
  const match = /^([a-z0-9][a-z0-9-]{2,38}[a-z0-9]):(.+)$/.exec(rest);
  if (!match) return undefined;
  const feature = FEATURE_RE.exec(match[2]);
  if (!feature) return undefined;
  if (feature[1]) return { serial: match[1], kind: feature[2], n: Number(feature[1]) };
  if (feature[3]) return { serial: match[1], kind: 'input', port: feature[3] };
  return { serial: match[1], kind: 'ring' };
}

/**
 * One Gladys device. `switches`: the numbers of the enabled switches;
 * `inputs`: the input ports; `existing`: the device as Gladys has it (its
 * features are kept: a switch or input not seen this time is never removed
 * from Discovery).
 */
export function buildDevice(
  gladys,
  { serial, model, firmware, name, host, switches, inputs },
  language,
  existing,
) {
  const ids = gladys.externalIds(DEVICE_TYPE, serial);
  const lang = language === 'en' ? 'en' : 'fr';
  const numbers = new Set(switches);
  const ports = new Set(inputs);
  for (const feature of existing?.features ?? []) {
    const parsed = parseFeatureId(gladys, feature.external_id);
    if (parsed?.serial !== serial) continue;
    if (parsed.n) numbers.add(parsed.n);
    if (parsed.port) ports.add(parsed.port);
  }
  const features = [{ ...RING, name: TEXT.ring[lang], external_id: ids.feature(RING_KEY) }];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    features.push(
      {
        ...SWITCH_STATE,
        name: TEXT.switchState[lang](n),
        external_id: ids.feature(switchKey(n, 'state')),
      },
      {
        ...BUTTON,
        name: TEXT.switchOpen[lang](n),
        external_id: ids.feature(switchKey(n, 'open')),
      },
    );
  }
  for (const port of [...ports].sort()) {
    features.push({
      ...INPUT,
      name: TEXT.input[lang](port),
      external_id: ids.feature(inputKey(port)),
    });
  }
  const label = [model, name].filter(Boolean).join(' ');
  return {
    name: existing?.name ?? label,
    external_id: ids.device,
    features,
    params: [
      { name: 'address', value: host },
      { name: 'model', value: model },
      { name: 'serial', value: serial.toUpperCase() },
      { name: 'firmware', value: firmware || '-' },
    ],
  };
}
