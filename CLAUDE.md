# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for 2N IP intercoms and access
units, over their local HTTP API (HTTPS, pinned certificate): a Node.js service (Node 22+, ESM, no
build step) in its own sandboxed Docker container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
npm run lint
npm run format:check
```

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   the SDK handlers, shared with the tests; getConfig() retried without end
src/app.js                        IntercomApp: configuration, sessions, pins, Discovery, states, events, status
src/session.js                    one intercom: reading cycle, identity, switches, inputs, calls, event channel, activations
src/api.js                        the HTTP API of the intercom (pure: paths, envelope, parsers)
src/http.js                       one request on a pinned TLS connection: Basic/Digest, budget, size cap, "sent or not"
src/events.js                     rate limit of what is published
src/devices.js                    Gladys devices (pure)
src/store.js                      /data: trusted certificates, refused credentials (8-bit salted fingerprint)
src/config.js, src/constants.js   normalization, every bound and timing
src/i18n.js                       French and English texts
test/                             node --test, the SDK fake Gladys + test/helpers/fake2n.js (HTTPS)
```

Safety rules (see TODO.md "Decisions"): nothing is sent before the
certificate of the address is pinned, and never to another certificate;
activating a switch is off by default, a push button, never a switch, only
for a monostable switch of 60 s at most; the option is read again right
before the bytes leave; the serial number and the switch capabilities are
read right before every activation; an activation is never sent again; a
command never waits for a reading, and a reading that left before a command
is never applied after it; a refused password is never tried again
automatically; the password, codes and card numbers are never logged nor
written to `/data`.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was the one exception). `test/manifest.test.js` checks they
  agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests touch loopback only, and every wait in them is bounded.
