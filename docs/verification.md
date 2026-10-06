# Verification

`npm run verify` checks types, Oxlint, and 12 domain/integration tests. The tests use actual local HTTP responses, filesystem writes, and the real Oxlint CLI. They cover identifiers, numeric vanity URLs, settings, graph metrics, privacy, CSV escaping, history intervals, pacing/retries, malformed provider data, checkpoint interruption/resume, invalid-key resume, damaged-run isolation, local HTTP boundaries, distinct operation identities, exports, CLI exits, and assertion-comment enforcement.

Chrome checks used the same local Steam fixture through the real browser UI:

- Estimate and capped scan with optional owned games.
- Numeric vanity URL resolution, consecutive failed-scan notices, and repeated cancellation/resume of the same run. Each cancellation reloads its report.
- Friend filtering, saved-profile save/load, graph keyboard selection and retained focus.
- Scan, Results, History, and Connection navigation preserves form values and filters. Reloading a saved-run URL opens Results; clicking Scan during that load keeps Scan selected. Cancellation works from History and Connection.
- All six scan exports and the attached history export returned HTTP 200.
- Normalized history file upload and report rendering.
- Desktop at 1440 × 1000 and mobile at 390 × 844, plus 650 and 900 pixel widths, with no page-level horizontal overflow in any view. Wide tables scroll within their container. Keyboard controls show visible focus, and Chrome reported no page errors.
- Primary text, secondary labels, and the scan button exceed 4.5:1 contrast on their surfaces; graph edges exceed 3:1 against the inset background. No looping CSS animation.

Screenshots show the classic Steam UI with fixture data: [scan setup](screenshots/scan.png), [desktop report](screenshots/desktop.png), [mobile report](screenshots/mobile.png).

Authenticated live Steam requests were not tested because the development environment has no Steam API key. Provider contracts follow Steam's official documentation, but real account visibility and publisher group permissions still need a credentialed check. CI runs the locked installation and verification on Linux, Windows, and macOS.
