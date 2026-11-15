// -----------------------------------------------------------------------------
// One request to the HTTP API of a 2N IP intercom, over HTTPS with a pinned
// certificate:
// - the intercoms show a self-signed certificate: the CA check cannot pass,
//   so it is replaced by a pin. Every connection is a bare TLS handshake
//   first; the SHA-256 fingerprint of the certificate seen is compared with
//   the pinned ones BEFORE anything is written or read. No pin, or another
//   certificate: the socket is closed, nothing was sent (the password, even
//   a Digest proof of it, never reaches another server);
// - then one HTTP request on that socket (`createConnection`, no agent,
//   `Connection: close`): one request per connection, never a pipeline, so
//   "connected" means "this request may now be written";
// - `beforeSend()`, called once the certificate is checked, right before the
//   request is written: anything but true withdraws it (nothing written);
// - the answer read up to `maxBody` bytes, then cut;
// - one budget for the whole request (`timeout`), the Digest exchange
//   included, and an AbortSignal (a command takes the device from a reading);
// - an error that tells whether the request may have reached the device
//   (`sent`): a refused or timed out connection never did, a 401 did nothing.
// Authentication: none, Basic (the password in every request, inside TLS),
// or Digest (RFC 7616, MD5 or SHA-256, the default of the intercoms): with
// Digest the password never leaves; a device that asks for Basic while
// Digest is configured gets nothing. Neither the password nor the
// Authorization header is ever logged; errors never carry the path.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { LIMITS, TIMINGS } from './constants.js';
import { own, safeJson } from './json.js';

/**
 * kind:
 * - `nopin`: no certificate trusted for this address (nothing sent);
 * - `pin`: the device shows another certificate (nothing sent; `fingerprint` seen);
 * - `offline`: no connection (nothing sent);
 * - `withdrawn`: `beforeSend` said no (nothing sent);
 * - `aborted`: taken back by the caller (sent if `sent`);
 * - `timeout`: no (complete) answer in time;
 * - `lost`: the connection ended after the write;
 * - `refused`: the device refused the credentials (401), nothing done;
 * - `basic-only`: Digest configured, the device asks for Basic (nothing sent);
 * - `method`: the device does not allow this authentication method (error 8);
 * - `privilege`: the user lacks the privilege of this function (error 10, or 403);
 * - `disabled`: the function or service is off in the HTTP API page (error 4);
 * - `unsupported`: 404, or a function this model or firmware lacks (errors 1-3);
 * - `device`: 5xx, or the device could not do it (errors 14, 15, 18...);
 * - `answer`: an answer that is not what was expected (or too large).
 */
export class IntercomError extends Error {
  constructor(message, kind, { sent = false, status, code, fingerprint } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.status = status;
    this.code = code;
    this.fingerprint = fingerprint;
  }
}

export const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const hash = (algorithm, text) =>
  createHash(algorithm.startsWith('SHA-256') ? 'sha256' : 'md5')
    .update(text)
    .digest('hex');

/**
 * The challenges of a WWW-Authenticate header, by scheme. Node joins several
 * such headers with ", ": a parameter belongs to the last scheme seen.
 */
export function parseChallenges(header) {
  if (typeof header !== 'string' || header.length > 4096) return {};
  const schemes = {};
  let current;
  for (const [, name, value] of header.matchAll(
    /([A-Za-z][\w-]*)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]*))?/g,
  )) {
    if (value === undefined) {
      const scheme = name.toLowerCase();
      current = schemes[scheme] = Object.create(null);
    } else if (current) {
      current[name.toLowerCase()] = value.startsWith('"')
        ? value.slice(1, -1).replace(/\\(.)/g, '$1')
        : value;
    }
  }
  return schemes;
}

const quote = (text) => `"${String(text).replace(/(["\\])/g, '\\$1')}"`;

/** The Authorization header of a Digest challenge (RFC 7616). */
export function digestHeader({ username, password }, challenge, method, uri, nc, cnonce) {
  const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase();
  if (!['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'].includes(algorithm)) return undefined;
  const qops = (challenge.qop ?? '').split(',').map((q) => q.trim().toLowerCase());
  const qop = qops.includes('auth') ? 'auth' : undefined;
  if (challenge.qop && !qop) return undefined; // auth-int only: not supported
  let ha1 = hash(algorithm, `${username}:${challenge.realm ?? ''}:${password}`);
  if (algorithm.endsWith('-SESS')) ha1 = hash(algorithm, `${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = hash(algorithm, `${method}:${uri}`);
  const ncText = nc.toString(16).padStart(8, '0');
  const response = qop
    ? hash(algorithm, `${ha1}:${challenge.nonce}:${ncText}:${cnonce}:${qop}:${ha2}`)
    : hash(algorithm, `${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm ?? '')}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
    `algorithm=${challenge.algorithm ?? 'MD5'}`,
    `response=${quote(response)}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncText}`, `cnonce=${quote(cnonce)}`);
  if (challenge.opaque !== undefined) parts.push(`opaque=${quote(challenge.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}

const seenFingerprint = (socket) => {
  const fp = socket.getPeerCertificate()?.fingerprint256;
  return typeof fp === 'string' && FINGERPRINT.test(fp) ? fp : undefined;
};

const tlsOptions = (host) => ({
  host: host.address,
  port: host.port,
  servername: isIP(host.address) ? undefined : host.address,
  // Self-signed certificate: the CA check cannot pass; the pin checked on
  // `secureConnect`, before any byte is written, replaces it.
  rejectUnauthorized: false,
});

/**
 * The fingerprint of the certificate the device shows: a bare handshake,
 * nothing is written. Rejects an IntercomError (`offline`, `timeout`, `answer`).
 */
export function readFingerprint(host, timeout = TIMINGS.connectTimeout) {
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tls.connect(tlsOptions(host));
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new IntercomError('No TLS connection in time', 'timeout')),
      timeout,
    );
    socket.once('secureConnect', () => {
      const fp = seenFingerprint(socket);
      if (fp) finish(undefined, fp);
      else finish(new IntercomError('No certificate shown', 'answer'));
    });
    socket.on('error', (err) =>
      finish(new IntercomError(err?.code ?? 'Connection failed', 'offline')),
    );
  });
}

/** One HTTP exchange on a new pinned connection. Resolves { status, headers, text }. */
function exchange({ host, pins, method, path, headers, signal, beforeSend, maxBody }) {
  return new Promise((resolve, reject) => {
    if (!pins?.length) {
      reject(new IntercomError('No certificate trusted', 'nopin'));
      return;
    }
    let connected = false;
    let settled = false;
    let req;
    const socket = tls.connect(tlsOptions(host));
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const kill = () => {
      req?.destroy();
      socket.destroy();
    };
    const onAbort = () => {
      done(reject, new IntercomError('Taken back', 'aborted', { sent: connected }));
      kill();
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('error', (err) => {
      done(
        reject,
        new IntercomError(
          connected ? 'Connection lost' : (err?.code ?? 'Connection failed'),
          connected ? 'lost' : 'offline',
          { sent: connected },
        ),
      );
      kill();
    });
    socket.once('secureConnect', () => {
      if (settled) return;
      const fp = seenFingerprint(socket);
      if (!fp || !pins.includes(fp)) {
        done(
          reject,
          new IntercomError('The certificate of the device changed', 'pin', { fingerprint: fp }),
        );
        kill();
        return;
      }
      const veto = beforeSend();
      if (veto !== true) {
        done(
          reject,
          veto instanceof IntercomError ? veto : new IntercomError('Withdrawn', 'withdrawn'),
        );
        kill();
        return;
      }
      connected = true;
      // No agent: the verified socket is the connection (never `agent: false`).
      req = httpRequest({
        host: host.address,
        port: host.port,
        method,
        path,
        headers: { Accept: 'application/json', ...headers, Connection: 'close' },
        createConnection: () => socket,
      });
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBody) {
          done(reject, new IntercomError('Answer too large', 'answer', { sent: true }));
          kill();
          return;
        }
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBody) {
            done(reject, new IntercomError('Answer too large', 'answer', { sent: true }));
            kill();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          done(resolve, {
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', () =>
          done(reject, new IntercomError('Connection lost', 'lost', { sent: true })),
        );
        res.on('aborted', () =>
          done(reject, new IntercomError('Connection lost', 'lost', { sent: true })),
        );
      });
      req.on('error', () => {
        done(reject, new IntercomError('Connection lost', 'lost', { sent: true }));
        kill();
      });
      req.end();
    });
  });
}

/** The 2N error code of an answer body, or undefined. */
export function errorCode(text) {
  try {
    const body = safeJson(text);
    const code = own(own(body, 'error'), 'code');
    return own(body, 'success') === false && Number.isInteger(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A request with its authentication and its budget. `session` keeps the last
 * Digest challenge of the device (and its counter), so a reading needs one
 * exchange, not two. A 401 that carries error 10 (the user lacks the
 * privilege of this function) is no refusal: it is returned as an answer.
 * Resolves { status, text }; rejects an IntercomError.
 */
export async function request({
  host,
  pins,
  method = 'GET',
  path,
  auth = { mode: 'none' },
  session = {},
  timeout,
  signal,
  beforeSend = () => true,
  maxBody = LIMITS.maxBody,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  let sentOnce = false;
  try {
    for (let round = 0; round < 2; round += 1) {
      const headers = {};
      if (auth.mode === 'basic') {
        headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      } else if (auth.mode === 'digest' && session.challenge) {
        session.nc = (session.nc ?? 0) + 1;
        const value = digestHeader(
          auth,
          session.challenge,
          method,
          path,
          session.nc,
          randomBytes(8).toString('hex'),
        );
        if (value) headers.Authorization = value;
      }
      let answer;
      try {
        answer = await exchange({
          host,
          pins,
          method,
          path,
          headers,
          signal: controller.signal,
          beforeSend,
          maxBody,
        });
      } catch (err) {
        if (err.kind === 'aborted' && timedOut) {
          throw new IntercomError(
            err.sent ? 'No answer in time' : 'Connection timed out',
            err.sent ? 'timeout' : 'offline',
            { sent: err.sent },
          );
        }
        throw err;
      }
      sentOnce = true;
      if (answer.status !== 401) return answer;
      // Authenticated, without the privilege of this function: an answer.
      if (errorCode(answer.text) === 10) return answer;
      // 401: nothing was done. With Digest, a first or stale challenge is
      // answered once; anything else is a refusal.
      const challenges = parseChallenges(answer.headers['www-authenticate']);
      const digest = challenges.digest;
      const fresh =
        auth.mode === 'digest' &&
        digest?.nonce &&
        (!session.challenge ||
          String(digest.stale).toLowerCase() === 'true' ||
          digest.nonce !== session.challenge.nonce);
      if (round === 0 && fresh) {
        session.challenge = digest;
        session.nc = 0;
        continue;
      }
      if (auth.mode === 'digest') session.challenge = undefined;
      const basicOnly = auth.mode === 'digest' && !digest && challenges.basic;
      throw new IntercomError(
        basicOnly ? 'The device asks for Basic' : 'Credentials refused',
        basicOnly ? 'basic-only' : 'refused',
        { status: 401 },
      );
    }
    throw new IntercomError('Credentials refused', 'refused', { status: 401 });
  } catch (err) {
    if (err instanceof IntercomError) {
      // A 401 round reached the device but did nothing: only the last round counts.
      if (err.kind === 'refused' || err.kind === 'basic-only') err.sent = false;
      throw err;
    }
    throw new IntercomError('Request failed', 'offline', { sent: sentOnce });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}
