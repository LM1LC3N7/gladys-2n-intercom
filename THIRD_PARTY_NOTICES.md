# Third-party notices

This integration bundles no third-party code and ports none. It talks to the
2N IP intercoms through their HTTP API as described in the official manual
"2N IP HTTP API" (version 3.3, firmware 2.50 LTS,
<https://wiki.2n.com/hip/hapi/latest/en>, read on 2026-11-15): the function
paths, their parameters, the answer envelope, the error codes and the event
names and parameters come from that manual. No text of the manual is copied.

Its only runtime dependency is `@gladysassistant/integration-sdk` (Apache-2.0),
installed from npm.

The test certificates of `test/fixtures` come from the gladys-testkit of the
same author (Apache-2.0); they are test material only, not in the image.

2N is a trademark of its owner, named only to say which devices the
integration talks to. This project is not affiliated with 2N.
