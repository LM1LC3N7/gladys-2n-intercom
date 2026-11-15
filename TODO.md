# TODO

## Decisions

- 2026-11-15 — Version 0.1.0 set by hand (package.json, lock, manifest, docker_image); the Release workflow
  owns it from now on. SDK `^0.16.0` (latest published on 2026-11-15). Gladys 5.3.3 is the latest core;
  `gladys_version` `>=5.1.0` (scene triggers), no `countries` (2N sells worldwide), no `keywords`.
- Reference: the official manual "2N IP HTTP API" 3.3 (firmware 2.50 LTS, wiki.2n.com/hip/hapi, read on
  2026-11-15). No library: none maintained in JS; the SmartHomeNG plugin (GPL) was not read.
- HTTPS only, certificate pinned (lot 24 rule, as gladys-gira): every connection is a bare TLS handshake,
  the SHA-256 fingerprint is compared before the first byte; no pin or another certificate = nothing sent,
  the fingerprint seen shown in the status. Pins: typed in the configuration (any of the list matches any
  address), or two clicks of "Trust the certificates" (the second within 2 min, same fingerprint seen
  again), kept in `/data` (written and awaited, 2 s at most, before anything is sent; not written = not
  trusted). A changed certificate is never learnt. Plain HTTP is not offered.
- Identity: the serial number of `/api/system/info` (lower case) makes the external ids; read at every
  cycle and right before every activation. An unreadable serial is never "another device".
- Activation (`switch-<n>:open`): button/push, off by default (`allow_open`), option read again in
  `beforeSend`; `/api/switch/ctrl?action=trigger` only on a switch read right before in `/api/switch/caps`
  as enabled, monostable, with a known duration of 1 to 60 s (a bistable switch would be toggled on for
  good). Never retried, never queued beyond 4 per device, never replayed. No closing command (the
  monostable switch turns off by itself), so no protective command to keep unblocked; `lock`, `hold`,
  `on`, `off` are not used.
- Confirmation (review r1, I1, M2): the state of the switch is read right before the trigger (never the
  one in memory); confirmed when it is read active after it and was read inactive before, or when the
  SwitchStateChanged event with originator `api` on that switch comes (only if read inactive before). The
  mark of an activation is set in `beforeSend`, right before the first byte (the device may push the event
  on the held channel read before the trigger answer), taken back when nothing left or the device refused;
  it lasts 30 s, 8 at most. That activation is no scene event: a scene opening on "switch activated" never
  loops.
- Events: `/api/log/subscribe` (include=new, 5 event types, duration 60 s) then `/api/log/pull` (timeout
  20 s) on a connection of its own; a read answered after more than 90 s of silence is dropped (old
  events); an unknown channel (error 12) is subscribed again at once, once; 20 events per read at most;
  an empty answer in less than 1 s waits 1 s. Events during a cut are lost (documented).
- A state read before a newer event of the same feature is not applied (`eventSeq`).
- Credentials: refused only on a 401 of `/api/system/info` to a request that carried credentials (Basic,
  or a Digest proof), after one answered challenge (8-bit salted mark per address in `/data`, lifted by
  changed credentials, a saved configuration or the test button). A 401 is judged against the challenge
  that request signed with (review r1, I2): a changed nonce is answered once, again changed is a device
  error, never a refusal; the shared challenge is cleared only if still that one. No credentials sent
  (none configured, auth-int, unknown algorithm) = `method` (M1). Error 9 without a 401 = unexpected
  answer. A 401 carrying error 10, a 403, a 401 elsewhere (switch, I/O, call, log, trigger) is never a
  refusal: "not allowed" for that endpoint, asked again after 1 min doubling to 1 h. Digest configured
  and the device asks for Basic: nothing sent.
- No code, card UID nor user UUID is read into an event; the directory user name only.
- `/data`: read bounded (2 s, 64 KB, regular file, no symbolic link); unreadable is never overwritten, and
  read again every 10 s on a timer of its own, one read at a time, until readable (review r1, I3): its
  pins and refusals then start the sessions again; a refusal seen meanwhile is kept.
- Categories: `security`.

## Later

- Confirm on a real device: the shape of `/api/call/status` (`result.sessions`), the duration of a
  handshake and of the 4 requests of an activation (3.3 s budget), whether `include=new` channels survive
  a long pull, the `upTime` of events, the error of an unknown channel id.
- Camera snapshot (`/api/camera/snapshot`) as a camera feature; `/api/io/ctrl` outputs (off by default).
- Mutation check of the guards: `memcap node scripts/mutants.mjs` (scripts/mutants.json).
