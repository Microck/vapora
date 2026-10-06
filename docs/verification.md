# Verification

The Scan workspace uses the supplied 1078 x 599 reference and the original `feature/gui-and-analysis` branch at `9ad203818f65f9716d56611e97ad37cf6a3b8a7f` as its foundation: Parameters above Outputs/Output, a five-slot avatar rail with save/load controls, and Target with stacked actions. Advanced scan options sit below these panels. Results adds run management and analysis tools. The toolbar has Scan and Results tabs, a key button, and browser exports or a native folder action.

The renderer bundles the original Motiva Sans regular, medium and bold fonts, checkbox bitmaps, key, save and load assets. Chrome's platform-font inspection confirmed that scan labels actually render with the bundled Motiva Sans. The UI uses the original olive palette, joined tabs, square beveled buttons, inset fields and mustard selection accents. There is no looping animation.

At the reference viewport, the parameters start at (36, 100) and measure 655 x 192px. Outputs/Output starts at (36, 318); the target avatar starts at (792, 172) and measures 210 x 210px. The toolbar eye is 20 x 11px, contains only white eye paths, and has no outer circle or blue background. The source PNG and favicon remain unchanged.

## Automated checks

`npm run verify` passed: TypeScript, Oxlint, build and all 15 domain/integration tests. Tests use real local HTTP and filesystem fixtures, without mocked modules or transports. Coverage includes:

- Profile avatars through summaries, checkpoints, cancellation/resume and run APIs, including missing images and rejected executable image URLs.
- Explicit private-profile skipping, retained incoming friendships and rankings, persisted policy, and no own friend/ban/group/game requests for skipped accounts.
- Missing visibility remains unavailable; a public profile with a private friend list still receives other enabled observations.
- A private target completes as skipped when the policy is enabled. Estimates respect the same policy and disclose first-two-level coverage at depth 3-5.
- Depth 4 and 5 query the selected boundary without admitting accounts beyond it.
- Explicit target lookup returns identity without creating a run, plus CLI depth 5 and skip-policy persistence.
- Existing provider pacing/retries, Host/Origin checks, key protection, graph metrics, exports and history contracts.
- Reranking without a key or provider requests, persisted settings and exports, unchanged observations, attached history reopening, and rejection of busy/incomplete runs, invalid weights and corrupt attachments before saving.

## Browser and desktop checks

Chrome drove the real browser UI against the local Steam HTTP fixture. It checked target lookup, a completed scan, loaded avatars, avatar clearing on target edits, depth 5, the skip checkbox, default settings across reload, named-profile save/load dialogs, depth-5 and private-target estimates, visible lookup errors, output filtering without changing scan settings, and visible keyboard focus. It also checked run search/status filters, visible coverage warnings, profile inspection, graph search and keyboard selection, zoom without rebuilding nodes, offline reranking across reload, standalone history import, attachment and reopening. Scan, Results, History and the open inspector/network had no page-level horizontal overflow at 320, 390, 560, 720, 940, 1078 and 1280px.

The Linux Electron app was launched with a new, initially nonexistent data directory. Its isolated renderer completed a lookup and scan. The actual native window maximized, restored to 1078 x 599px, minimized and closed with exit code 0. Open output folder launched Thunar for the outputs root and accepted the selected run after navigation. The renderer had no Node `require` access.

All current captures were opened and visually inspected:

- [Desktop Scan](screenshots/native.png)
- [Desktop completed run and output tree](screenshots/native-complete.png)
- [Browser Scan](screenshots/scan.png)
- [Browser Results](screenshots/desktop.png)
- [Narrow Results](screenshots/mobile.png)
- [Profile inspector](screenshots/inspector.png)
- [Community graph](screenshots/network.png)
- [Saved runs](screenshots/runs.png)
- [Attached history](screenshots/history.png)

The screenshots use distinct sample avatars from the HTTP fixture. They are not live Steam accounts. Authenticated live Steam calls and native Windows/macOS launches were not tested locally. CI verifies the locked install, types, lint and tests on Linux, Windows and macOS; that does not establish native desktop behavior on those systems.

Current saved settings require `skipPrivate`; checkpoints also require a nullable avatar field. Earlier local files remain untouched and are reported as invalid. Start a fresh scan or explicitly save a new settings profile; there is no automatic migration.
