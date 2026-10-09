# UI audit fixes

This pass fixes eight issues found in the browser UI at main commit
`87d42d1f87d73c5c596bfa8cad94475af8330486`. It keeps the olive Steam styling,
scan settings, analysis formulas, provider behavior and export data unchanged.

| Area | Corrected behavior |
| --- | --- |
| Ranking forms | Short labels stay consistent across both forms: Count scale, Location rule, Location scale and Hub cutoff. In-app help explains the original terms. Inputs and selects stay within their columns, share a 32 px height and align below labels. |
| Dialog errors | Save, Load and History import errors appear inside the open dialog and receive focus. Invalid fields expose their state to assistive technology. |
| Tooltip placement | Help chooses a position with the least overlap with nearby controls. Save settings help leaves Load settings clickable; profile help leaves Details clickable. |
| Offline actions | Apply says that settings were not saved, explains how to reconnect and retains that message during background polling. Retrying after reconnecting saves the settings. |
| Keyboard help | Evidence, mutual-count, location, ranking and history-count explanations have focusable help buttons. Static help descriptions remain available while the popover is closed. |
| Narrow tab strips | Tabs stay on one line with scroll arrows when needed. Selecting a tab reveals it beside its panel. |
| Comment identities | Comments use names and avatars already present in the history report. Search accepts those names and Steam IDs. No extra identity requests are added. |
| History formatting | Profile dates, booleans, ban states and singular durations use readable text. Original record details and downloads retain their supplied values. |

## Verification

- `npm run verify`: type checks, Oxlint and all 59 tests pass.
- `VAPORA_BROWSER=<chromium executable> npm run test:e2e`: all three browser
  tests pass against real local HTTP fixtures. The added test exercises the
  corrected forms, dialog errors, tooltip hit targets, offline retry, keyboard
  help, narrow tabs and history presentation.
- Manual browser checks: 1078 x 700 and 320 x 740 viewports, plus 200% CSS
  content zoom. The screenshots below were opened and inspected.
- Linux source Electron: ranking and API-key dialogs render; maximize reaches
  1280 x 878, restore returns to 1078 x 599, and the close control exits the app.

These checks use synthetic accounts and local provider fixtures, not a live
Steam scan. CSS content zoom does not certify native browser zoom behavior.
Windows and macOS packaged builds are not covered by the local checks;
the PR's desktop workflow packages and exercises all three platforms, including
the Windows portable download. No screen-reader certification is claimed.

## Before and after

Before images show the main commit above. After images show this change. Each
pair uses the same viewport and action; fixture account state can differ.

| View | Before | After |
| --- | --- | --- |
| Scan ranking dialog | ![Ranking dialog before](screenshots/ui-audit/ranking-dialog-before.png) | ![Ranking dialog after](screenshots/ui-audit/ranking-dialog-after.png) |
| Results ranking form | ![Results ranking before](screenshots/ui-audit/ranking-results-before.png) | ![Results ranking after](screenshots/ui-audit/ranking-results-after.png) |
| Narrow ranking dialog | ![Narrow ranking before](screenshots/ui-audit/ranking-narrow-before.png) | ![Narrow ranking after](screenshots/ui-audit/ranking-narrow-after.png) |
| Load error | ![Load error before](screenshots/ui-audit/load-error-before.png) | ![Load error after](screenshots/ui-audit/load-error-after.png) |
| Save settings tooltip | ![Tooltip before](screenshots/ui-audit/tooltip-before.png) | ![Tooltip after](screenshots/ui-audit/tooltip-after.png) |
| Offline Apply | ![Offline action before](screenshots/ui-audit/offline-before.png) | ![Offline action after](screenshots/ui-audit/offline-after.png) |
| Keyboard help | ![Keyboard help before](screenshots/ui-audit/keyboard-help-before.png) | ![Keyboard help after](screenshots/ui-audit/keyboard-help-after.png) |
| Narrow Results tabs | ![Narrow tabs before](screenshots/ui-audit/tabs-narrow-before.png) | ![Narrow tabs after](screenshots/ui-audit/tabs-narrow-after.png) |
| History comments | ![History comments before](screenshots/ui-audit/history-comments-before.png) | ![History comments after](screenshots/ui-audit/history-comments-after.png) |
| History profile | ![History profile before](screenshots/ui-audit/history-profile-before.png) | ![History profile after](screenshots/ui-audit/history-profile-after.png) |
| Invalid history import | ![History import before](screenshots/ui-audit/history-import-before.png) | ![History import after](screenshots/ui-audit/history-import-after.png) |
