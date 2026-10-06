# Verification

The UI follows the composition in `feature/gui-and-analysis` at `9ad203818f65f9716d56611e97ad37cf6a3b8a7f`: Parameters above Mode/Output, a middle utility rail, and Target with stacked actions on the right. OMP with `anthropic/claude-opus-5-5` supplied the starting critique and HTML/CSS draft after reviewing both original screenshots, the branch styles, the rejected UI, and the real logo. The implementation keeps one stylesheet and native radio controls for modes. The follow-up uses a content-sized Steam window on a black backdrop, a 164px logo on desktop, compact panels, and a content-sized recent-run list. Output previews, input-format help and method notes no longer occupy the default workspace. Native disclosures retain output files and report explanations; run failures stay visible.

`assets/vapora.png` and `assets/vapora.ico` are unchanged. `assets/placeholder.jpg` comes unchanged from the original GUI branch. The scanner stores no avatar URL, so the target image is explicitly a placeholder; its name comes only from a matching saved run. The static-file allowlist serves these bundled assets with their correct image types, and the HTTP test checks the logo byte for byte.

`npm run verify` checks types, Oxlint, and 12 domain/integration tests. The tests use actual local HTTP responses, filesystem writes, and the real Oxlint CLI. They cover identifiers, numeric vanity URLs, settings, graph metrics, privacy, CSV escaping, history intervals, pacing/retries, malformed provider data, checkpoint interruption/resume, invalid-key resume, damaged-run isolation, local HTTP boundaries, distinct operation identities, exports, CLI exits, and assertion-comment enforcement.

Chrome checks used the same local Steam fixture through the real browser UI:

- Estimate and capped scan with optional owned games.
- Numeric vanity URL resolution, consecutive failed-scan notices, and repeated cancellation/resume of the same run. Each cancellation reloads its report.
- Radio presets, switching to Custom after settings edits, saved-profile save/load, Enter-to-scan, and matching target identity. Friend filtering, graph keyboard selection and retained focus.
- Scan, Results, History, and Connection navigation preserves form values and filters. Reloading a saved-run URL opens its requested report even when the server retains another terminal job; clicking Scan during that load keeps Scan selected. Cancellation works from History and Connection.
- All six scan exports and the attached history export returned HTTP 200.
- Normalized history file upload and report rendering.
- Desktop at 1440 × 1000 and 1280 × 720, tablet at 1000 × 900, and mobile at 390 × 844, plus 320, 650, 900 and 940 pixel widths, with no page-level horizontal overflow in any view. Wide tables scroll within their container. Keyboard controls show visible focus, and Chrome reported no page errors.
- Follow-up checks measured the desktop logo at 164px with the original aspect ratio and the setup window below 450px tall. Output and scan-note disclosures open correctly; a saved failed-run fixture shows its error without opening notes. The compact layout also passes at 320px.
- Primary text, secondary labels, and the scan button exceed 4.5:1 contrast on their surfaces; graph edges exceed 3:1 against the inset background. No looping CSS animation.

Desktop screenshots capture the rendered application window; mobile shows the full page. All screenshots use fixture data: [scan setup](screenshots/scan.png), [desktop report](screenshots/desktop.png), [mobile scan setup](screenshots/mobile.png).

Authenticated live Steam requests were not tested because the development environment has no Steam API key. Provider contracts follow Steam's official documentation, but real account visibility and publisher group permissions still need a credentialed check. CI runs the locked installation and verification on Linux, Windows, and macOS.
