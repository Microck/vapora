# Verification

The Scan workspace uses the supplied 1078 x 599 reference and the original `feature/gui-and-analysis` branch at `9ad203818f65f9716d56611e97ad37cf6a3b8a7f` as its foundation: Parameters above Outputs/Output, a five-slot avatar rail with save/load controls, and Target with stacked actions. Ranking options open in a dialog from Parameters. Results adds run management and analysis tools, including a Ranking tab and Run info dialog. The toolbar has Scan and Results tabs, a key button, and browser exports or a native folder action. The UI has no native disclosure sections or repeated explanatory subtext; coverage failures remain visible.

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

Chrome drove the real browser UI against the local Steam HTTP fixture. It checked target lookup, a completed scan, loaded avatars, avatar clearing on target edits, depth 5, the skip checkbox, default settings across reload, named-profile save/load dialogs, depth-5 and private-target estimates, visible lookup errors, output filtering without changing scan settings, and visible keyboard focus. It also checked run search/status filters, visible coverage warnings, profile inspection, graph search and keyboard selection, zoom without rebuilding nodes, offline reranking across reload, standalone history import, attachment and reopening. Ranking options saved through Apply and reload; pressing Enter in that dialog closed it without starting a scan. Run info retained detailed warnings and closed with Escape. Scan, Results, History, Ranking, the open inspector/network and both dialogs had no page-level horizontal overflow at 320, 390, 560, 720, 940, 1078 and 1280px.

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
- [Scan ranking options](screenshots/ranking-options.png)
- [Saved-run ranking](screenshots/ranking.png)
- [Run info](screenshots/run-info.png)

The screenshots use distinct sample avatars from the HTTP fixture. They are not live Steam accounts. An authenticated live scan of the authorized Microck profile completed with five accounts, five loaded avatars, public group observations, four public game observations and one private game observation. The cap correctly reported partial coverage (4 of 48 direct friends admitted). All six exports were nonempty and contained no API key. The browser displayed the real identities and graph without renderer errors. A second five-account scan started from the browser Analyze control against Steam and completed; its saved report reopened after a server restart, with five loaded avatars and six valid exports. A live depth-1 CLI estimate also passed. These are bounded checks, not a claim that every Steam account or endpoint is always available.

The expanded E2E pass exercised cancellation and resume across browser/server and native-app restarts, real file downloads, offline reranking, history validation, retries and damaged current checkpoints. Linux and macOS native applications each passed nine workflow groups, including active-scan close/checkpoint/restart/resume, actual minimize/maximize/restore and output-folder actions. Native Windows verification could not finish: the clean test VM lacked the Visual C++ runtime needed by Electron's archive extractor, and runtime installation did not complete. See [the current E2E report](e2e-verification.md) for evidence and platform limits. CI core checks alone do not establish native desktop behavior.

## Interface review

Scope: the current Scan, Results, History, connection, graph, profile inspector and dialogs, using the supplied green Steam reference. This is the running application review, not a change review. The stack remains plain TypeScript and CSS. The product contract, this verification document and the workspace instructions establish the design conventions. Original fonts, source assets, olive surfaces, joined tabs and beveled controls remain intentional.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Keyboard focus, native dialog restoration, arrow-key table scrolling, accessibility-tree names, forced colors and depth target dimensions | Corrected depth target width, Details name and high-contrast icons |
| Layout | Desktop/narrow views, long and unbroken names, report column alignment and coverage separators | Corrected numeric alignment, long-name avatar alignment and wrapped coverage borders |
| Writing | Scan/report/dialog labels and evidence scale | Removed the repeated score denominator from each friend row |
| Typography | Bundled fonts, narrow form sizes and long-name wrapping | Corrected mobile inputs and wrapped identity line heights |
| Colors | Computed foreground/background pairs, including selected tabs, notices and table rows | Corrected gold text and selection contrast |
| UI polish | Original eye size, square controls, tabs, selected states and source icons | Retained the reference structure; no decorative motion added |

All findings below were corrected:

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH | Colors | `ui/style.css:9` | Gold `#c4b550` on olive `#4c5844` measured 3.61:1; white selection text measured 3.70:1 | Gold `#d8cc75` measures 4.60:1; white on selection `#746b30` measures 5.40:1 | Normal text must remain readable in active and selected states |
| HIGH | Accessibility | `ui/style.css:83` | Adjacent depth buttons were 20px wide without spacing | Buttons measure 24 x 32px | Adjacent targets need distinct usable hit areas |
| MEDIUM | Typography | `ui/style.css:206` | Narrow inputs inherited 13-16px text depending on their section | Narrow inputs/selects consistently use 16px | Avoid small input text and unwanted iOS input zoom |
| MEDIUM | Accessibility | `ui/style.css:233` | White brand/bitmap icons disappeared against a forced white canvas | Original icons keep a dark backing in forced colors | The icon-only controls must stay visible in high contrast |
| LOW | Layout / writing | `ui/style.css:172`, `ui/index.html:178`, `ui/app.ts:155` | Numeric values aligned left and every score repeated `/ 100` | Values and headers align right; the scale appears once in the heading | Compare rows more easily with less repeated text |
| LOW | Layout / typography | `ui/style.css:110`, `ui/style.css:256` | Long inspector names centered their avatar midway through wrapped text; line height was 1.3 | Avatar aligns with the first line; wrapped identity line height is 1.4 | Keep the avatar tied to the start of the name and wrapped text readable |
| LOW | Accessibility | `ui/app.ts:154` | Visible Details button announced Inspect | Announces Details for the profile name | Accessible names include their visible labels |
| LOW | Layout | `ui/style.css:273`, `ui/style.css:286` | Coverage borders continued at some wrapped row ends | Three- and two-column row ends omit their trailing border | Keep the compact coverage table consistent across widths |

Additional browser checks used real local HTTP fixtures with deliberately long names at 320px, 1078px and a 539 x 300px viewport equivalent to the reference window's 200% zoom layout. They found no page overflow or unnamed exposed controls. Native dialogs returned focus to their trigger; ArrowRight scrolled the friends table. Rendered normal-text pairs measured at least 4.60:1. Forced colors were checked through Chrome's emulation; this is not a claim of full WCAG conformance.

Screenshot capture now waits for the visible images to finish loading and for the bundled fonts. The first fresh Results capture caught the transient empty avatar frames before their HTTP responses arrived; it was replaced after adding the readiness check. The final browser/desktop captures retain the fixture avatars throughout.

Not verified: an actual iOS Safari session, physical screen-reader speech output, native Windows/macOS high-contrast rendering, or large live Steam networks. The latest simplification pass reviewed the identity fix and browser regression test. It reused the standard timer primitive and corrected test cleanup and filesystem-error handling; it made no further product behavior changes.

Verdict: Approve within the inspected scope. No unresolved high-severity findings in that scope.

Current saved settings require `skipPrivate`; checkpoints also require a nullable avatar field. Earlier local files remain untouched and are reported as invalid. Start a fresh scan or explicitly save a new settings profile; there is no automatic migration.
