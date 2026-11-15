# gladys-2n-intercom

External integration for [Gladys Assistant](https://gladysassistant.com) (5.1.0 or later): 2N IP
intercoms and access units on the local network, through their official HTTP API over HTTPS (pinned
self-signed certificate). **Unofficial, not affiliated with 2N. Never tested with a real device.**

- a doorbell (read only), 1 while a visitor's call rings;
- the state of the switches (door locks, 1 to 4) and of the digital inputs, read only;
- one "Activate switch" push button per switch, **off by default** (never a switch); monostable switches
  only (60 s at most), they turn off by themselves;
- scene triggers: doorbell, switch activated, access granted, access denied (from the event channel of
  the intercom);
- nothing is sent to an intercom before its certificate is trusted (two clicks, or a typed fingerprint).

User guide: [français](docs/fr.md) · [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (fake Gladys of the SDK, fake 2N intercoms on loopback HTTPS)
npm run lint
npm run format:check
npm run cover          # regenerates cover.png
node scripts/mutants.mjs   # mutation check of the guards (use memcap)
```

Architecture, rules and decisions: [CLAUDE.md](CLAUDE.md) and [TODO.md](TODO.md). Written from the
official "2N IP HTTP API" manual (<https://wiki.2n.com/hip/hapi/latest/en>), no third-party code, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0, see [LICENSE](LICENSE). 2N is a trademark of its owner, used here only to say which devices
the integration talks to.
