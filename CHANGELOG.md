# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: 2N IP intercoms and access units over their official local
  HTTP API, over HTTPS with a pinned certificate (two clicks of "Trust the
  certificates", or typed fingerprints): nothing is sent before.
- Doorbell (ringing while a visitor's call rings), switch and input states,
  read only; one activation push button per switch, off by default,
  monostable switches of 60 s at most only, never sent again.
- Scene triggers from the event channel of the intercom: doorbell, switch
  activated, access granted, access denied.
- Refused credentials kept in `/data` (a salted 8-bit fingerprint) so an
  intercom is not asked again in a loop; lifted by new credentials, a saved
  configuration or the test button; `/data` read again every 10 s while
  unreadable.
