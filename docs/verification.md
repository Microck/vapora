# Verification

The UI follows `feature/gui-and-analysis` at `9ad203818f65f9716d56611e97ad37cf6a3b8a7f`: Parameters above Mode/Output, a middle utility rail, and Target with stacked actions. OMP with `anthropic/claude-opus-5-5` supplied the starting critique and draft from the original screenshots, branch styles and logo. The current skin uses the original green Steam palette, Arial 13px, joined page tabs, square beveled buttons and inset fields. It has no looping animation.

The toolbar displays the white eye SVG at 20 × 11px, preserving its aspect ratio. The SVG contains only the original eye, with both outer-circle contours removed. The PNG source and favicon are unchanged. The target avatar is 64px, the report avatar 40px, and recent/friend thumbnails 24px, all square.

Steam's `avatarfull` field survives summary decoding, enrichment, checkpoint save/resume, and the browser API. Missing provider images become `null`; failed image loads use the existing local placeholder once. Changing the target immediately clears an unrelated identity. Avatars use no referrer, and the browser permits HTTPS images plus the configured fixture origin. No Steam requests run while typing.

`npm run verify` passed: types, Oxlint, build and all 12 domain/integration tests. Existing real HTTP and filesystem tests now also check avatar preservation through cancellation/resume and the run/recent APIs, absent images, avatars on accounts with private friend lists, and rejection of executable image URLs. No modules or transports are mocked.

Chrome checks used the real UI and local Steam HTTP fixture:

- Submitted a numeric vanity profile URL through Analyze, completed a four-profile scan, and rendered the report and graph nodes.
- Confirmed target, report, friend and recent images had loaded image bytes. All three friends displayed distinct avatar URLs.
- Editing the target cleared its old name and picture. A failed image loaded the local placeholder.
- Checked Scan and Results at 320, 390, 560, 720, 940 and 1280px without page-level horizontal overflow. Analyze retained a visible keyboard focus indicator.
- Captured and opened the actual [scan](screenshots/scan.png), [report](screenshots/desktop.png), [mobile](screenshots/mobile.png) and native-size [eye](screenshots/logo.png).
- Checked all three standalone layout prototypes at the same six widths: loaded embedded images, navigation, friend filtering, keyboard tabs, variant switching and reload. No external prototype requests or browser errors. All nine option captures were opened and inspected; see [comparison notes](ui-options.md).

Pictures in the screenshots are distinct sample avatars from the local HTTP fixture, not live accounts. Authenticated live Steam access was not tested. CI runs the locked installation and verification on Linux, Windows and macOS.

Current checkpoints include a required nullable avatar field. Earlier checkpoints without it need a fresh scan; existing files are preserved and are not migrated automatically.
