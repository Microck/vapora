# Classic Steam UI options

The white eye has no outer circle. All three previews use the OG-Steam olive palette, Arial 13px, square beveled buttons, inset fields, checkbox marks, radio dots and page tabs that join their panels.

These are read-only layout prototypes from an OMP Opus 5.5 draft, refined against the existing GUI and the current app. They use the same local fixture report. They do not scan Steam, verify keys, import history or write files.

| Option | Layout | Desktop | Results | Mobile |
| --- | --- | --- | --- | --- |
| A | Original workspace: parameters and mode left, saved settings middle, target right | [Scan](screenshots/options/option-a-scan.png) | [Results](screenshots/options/option-a-results.png) | [Mobile](screenshots/options/option-a-mobile.png) |
| B | Compact properties dialog: target at the top, settings in tabs, actions at the bottom | [Scan](screenshots/options/option-b-scan.png) | [Results](screenshots/options/option-b-results.png) | [Mobile](screenshots/options/option-b-mobile.png) |
| C | Library split view: runs and saved settings on the left, workspace on the right | [Scan](screenshots/options/option-c-scan.png) | [Results](screenshots/options/option-c-results.png) | [Mobile](screenshots/options/option-c-mobile.png) |

[Switchable preview](https://github.com/Microck/vapora/blob/df4837c8391efb58aa4403c060f9657079d84022/docs/prototypes/steam-ui-options.html). Download the single HTML file and open it in a browser. It embeds all assets. The bottom bar switches A/B/C, and `?variant=A`, `B` or `C` opens a specific option.

The prototype source stays on `design/steam-ui-options`, outside the PR to `main`. Choose a layout before replacing the app's layout. The app keeps one implementation.

Verification: all nine screenshots opened and inspected; each option checked at 320, 390, 560, 720, 940 and 1280px; Scan, Results, History and Connection navigation; report filtering; keyboard tab navigation; switcher persistence across reload. No browser errors or page-level horizontal overflow.

References:

- [Existing Vapora GUI](https://github.com/Microck/vapora/blob/9ad203818f65f9716d56611e97ad37cf6a3b8a7f/playwright-ui-design2.png)
- [OG-Steam controls](https://images.gamebanana.com/img/ss/mods/6109019c78bc6.jpg)
- [OG-Steam scheme](https://github.com/ungstein/OG-Steam/blob/main/OG-Steam/resource/steamscheme.res)
