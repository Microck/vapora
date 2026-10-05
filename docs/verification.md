# Rewrite verification

`npm run verify` checks types, Oxlint, and 12 domain/integration tests. The tests use actual local HTTP responses, filesystem writes, and the real Oxlint CLI. They cover identifiers, numeric vanity URLs, settings, graph metrics, privacy, CSV escaping, history intervals, pacing/retries, malformed provider data, checkpoint interruption/resume, invalid-key resume, damaged-run isolation, local HTTP boundaries, distinct operation identities, exports, CLI exits, and assertion-comment enforcement.

Chrome checks used the same local Steam fixture through the real browser UI:

- Estimate and capped scan with optional owned games.
- Numeric vanity URL resolution, consecutive failed-scan notices, and repeated cancellation/resume of the same run. Each cancellation reloads its report.
- Friend filtering, saved-profile save/load, graph keyboard selection and retained focus.
- All six scan exports and the attached history export returned HTTP 200.
- Normalized history file upload and report rendering.
- Desktop at 1440 × 1000 and mobile at 390 × 844, with no page-level horizontal overflow. Wide tables scroll within their container.

Screenshots show fixture data: [desktop](screenshots/desktop.png), [mobile](screenshots/mobile.png).

Authenticated live Steam requests were not tested because the development environment has no Steam API key. Provider contracts follow Steam's official documentation, but real account visibility and publisher group permissions still need a credentialed check. CI runs the locked installation and verification on Linux, Windows, and macOS.
