# usage

Setup, scan settings, CLI commands and export formats for the current app. For desktop downloads and a first scan, start with the [README](../README.md).

## from source

```sh
git clone https://github.com/Microck/vapora.git
cd vapora
npm ci
npm run build
```

Enter your API key in the app for the current session, or copy `.env.example` to `.env` and fill in `STEAM_API_KEY`. An environment variable also works. The key field clears after saving; the key stays on the local server and does not appear in reports or exports.

`npm ci` downloads Electron's native binary for source launches. Linux needs a graphical desktop and GTK/NSS libraries. Windows source installs need the Microsoft Visual C++ runtime for its architecture: [x64](https://aka.ms/vs/17/release/vc_redist.x64.exe) or [ARM64](https://aka.ms/vs/17/release/vc_redist.arm64.exe).

Core and CLI checks passed on Linux, Windows and macOS CI, with browser E2E on Linux. Native packaged Electron checks run on Linux, Windows and macOS. The desktop workflow builds native downloads and tests the installed or extracted app before saving artifacts; see each release's checks for its verified platforms.

## quickstart

### browser

```sh
npm start -- serve
```

Open the printed `http://127.0.0.1:3000` address. Use the printed address if you choose another port. The server binds to loopback; run it on a trusted local machine.

In **Scan**, enter a target, choose depth and node cap, then **Analyze**. The check button fetches its name and avatar without starting a scan. **Estimate** samples public friend lists. **Apply** saves default settings; the save/load icons manage named profiles. **All / Report / Gephi** filters visible output files without changing the scan.

Open **Results** to browse saved runs, inspect friends, explore the network or download exports. **Ranking** saves new weights for a completed run without making Steam requests. **Import history** also works without a selected run. Progress and cancellation stay accessible when switching views.

### desktop

```sh
npm run desktop
```

The same app runs in a native Electron window. Window buttons minimize, maximize/restore and close it. **Open output folder** opens the selected run directory or the outputs root. Closing an active scan saves a resumable checkpoint.

Browser and CLI data default to the working directory; use `--root DIRECTORY` to choose another location. Installed desktop data defaults to the OS app-data directory under `Vapora`. The Windows portable EXE stores runs, settings and session files in `Vapora-data` beside the EXE. Move that folder together with the EXE to keep your saved runs. Set `VAPORA_ROOT` to choose another desktop data location. Use the same root to share runs between launches, with one process operating on a saved run at a time.

### command line

```sh
npm start -- scan 'https://steamcommunity.com/id/example' --preset inner
npm start -- scan '76561198000000000' --depth 5 --skip-private --games --max-nodes 200
npm start -- estimate '76561198000000000' --depth 2
npm start -- recent
npm start -- resume RUN_ID
npm start -- analyze RUN_ID
npm start -- profile-save small --depth 1 --max-nodes 100
npm start -- scan TARGET --profile small
npm start -- profiles
npm start -- history profile.json --run RUN_ID
npm start -- serve --port 3001 --root ./research
npm start -- --help
```

CLI scans and estimates use `STEAM_API_KEY` from the environment or `.env`. History import, report rebuilding and profile commands work without a key. Use `/id/NAME` for vanity names, including numeric ones; `/profiles/ID` and bare numeric targets identify SteamID64 accounts.

## configuration

Defaults come from [`src/model.ts`](../src/model.ts). Saved profiles contain settings only.

| Setting | Default | Range or behavior |
| --- | --- | --- |
| Depth | 2 | 1-5; depth 1 admits the target and direct friends |
| Nodes | 500 | Hard cap of 1-1000 accounts, including the target |
| Requests/min | 120 | 1-120; every provider request is paced |
| Skip private profiles | Off | Keep known private accounts and incoming links; skip their own observations |
| Shared groups | Off | Optional group observations and edges |
| Shared games | Off | Optional public owned-game overlap |
| Hub percentile | 0.99 | 0.5-1; graphs with zero betweenness have no hubs |
| Ranking weights | Mutual 1, Jaccard 1, groups 0.5, games 0.5 | Each accepts 0-100 |

The CLI presets are `inner` with depth 1 and cap 300, and `community` with the defaults above. GUI output choices select files, not presets.

A private friend list remains different from an empty public list. With private skipping enabled, missing profile visibility is still unknown; it is not treated as proof of privacy. Public profiles with private friend lists can provide other enabled observations. Group access can be denied; Vapora reports it as unavailable and stops further group requests in that operation.

Estimates sample at most five friend lists and respect the node cap. At depth 3-5, they describe the first two levels rather than predict the whole network. Scans query admitted boundary profiles for ranking signals without expanding beyond the chosen depth or cap.

## how it works

1. Resolve the target and collect profiles through the Steam Web API.
2. Walk friendships breadth first, saving checkpoints after completed scan units.
3. Build an undirected friendship graph with separate optional group edges.
4. Compute communities, centrality, friend rankings and location signals.
5. Save reports and exports in a unique run folder.

Vapora uses public API observations and local history files. It does not bypass Steam privacy or scrape SteamHistory. Missing observations and truncated graphs remain visible in the report.

## reports and exports

```text
outputs/<run-id>/
  scan.json
  analysis.json
  probable-friends.csv
  run.log
  gephi/
    nodes.csv
    edges.csv
  history.json          # when attached
```

`scan.json` holds settings, profile observations and the resume frontier. `analysis.json` holds metrics, rankings and coverage. `run.log` holds timestamped progress and diagnostic details.

| CSV | Columns |
| --- | --- |
| `gephi/nodes.csv` | `Id`, `Label`, `degree`, `betweenness`, `modularity_class`, `is_seed`, `is_hub`, `is_banned`, `is_public` |
| `gephi/edges.csv` | `Source`, `Target`, `Kind` with `friend` or `group` |
| `probable-friends.csv` | `candidate_steamid`, `name`, `score`, `evidence_score`, `mutual_count`, `jaccard_with_seed`, `shared_groups`, `shared_games`, `friends_status` |

CSV fields are quoted when needed, and formula-like text is escaped for spreadsheet imports. Steam IDs stay strings in JSON; set spreadsheet ID columns to text.

### gephi how-to

1. Create a project and import `gephi/nodes.csv` as a nodes table.
2. Import `gephi/edges.csv` as undirected edges.
3. Filter `Kind` to `friend` for friendship analysis; include `group` for shared membership.
4. Run ForceAtlas2, color by `modularity_class`, and size by `betweenness` or `degree`.

Start with friendship edges, then inspect shared-group links separately. Degree filters and k-core analysis can help explore dense groups. Communities and centrality describe the collected graph, which may cover only part of a person's network.

### probable friends and location signals

Friend ranking combines mutual count, neighbor-set Jaccard similarity, shared groups and shared games. The evidence score scales the highest observed score to 100. Missing signals stay unknown, and a private friend list can still have mutuals observed through another public list.

Location signals group self-reported Steam country, state and city codes among admitted direct friends. Each contribution has weight `1 + observed mutuals`.

**These are network heuristics, not proof of real-life friendship or residence.** Privacy, depth and node caps affect the result. The report shows coverage and partial-result warnings.

![Network exploration and profile inspection](screenshots/network.png)

## SteamHistory imports

Use **Import history** or `npm start -- history FILE` with a local normalized JSON file:

```json
{
  "steamID64": "76561198000000000",
  "name": "Example",
  "lastChecked": 1750000000,
  "historic": {
    "friends": [
      { "Friend": "76561198000000001", "FriendDate": 1700000000, "UnfriendDate": 0, "Name": "Friend" }
    ],
    "persona": [],
    "url": [],
    "pfp": [],
    "comments": []
  }
}
```

Dates are Unix seconds. A missing or zero `UnfriendDate` means still friends at `lastChecked`. Invalid intervals fail visibly; overlapping intervals count once. NDJSON files must hold normalized snapshots of one account; the latest `lastChecked` wins. Friendship duration stays separate from network scores.

Attach history only to a run for the same Steam account, or import it independently. Attached history reopens with the run and adds `history.json` to its exports. Browser imports accept up to 2 MB.

## troubleshooting

| Problem | What to do |
| --- | --- |
| Access denied | Check the API key. Group access may require publisher permissions. |
| Private or unavailable observations | Check the coverage report. Vapora cannot bypass profile privacy. |
| Failed or cancelled scan | Fix the reported issue, open the saved run and Resume. After a server restart, a run still marked running can also be resumed. |
| Invalid checkpoint | Start a fresh run. Legacy Python files and earlier local formats are not migrated; existing files remain untouched. |
| Slow scan | Reduce depth, node cap or optional group/game requests. |
| Port in use | Run `npm start -- serve --port 3001`. |
| Missing `VCRUNTIME140.dll` on Windows | Install the matching Visual C++ runtime linked above, then relaunch. |
| Checkpoint save failed | Read the filesystem code in the error. Free disk space or fix permissions as directed; close apps holding the file. Vapora retries brief Windows replacement blocks. After fixing the issue, choose Resume run. The last successfully saved checkpoint remains available. |
| Disk error while saving ranking | Fix disk space or permissions, then run `npm start -- analyze RUN_ID --root DIRECTORY` to regenerate exports from the saved checkpoint. |

## development and releases

```sh
npm ci
npm run verify
VAPORA_BROWSER=/path/to/chrome npm run test:e2e
npm run package
npm run dev
```

`verify` checks types, Oxlint, build and the domain/integration suite. The browser E2E suite needs installed Chrome/Chromium and checks real HTTP fixtures, persistence and downloads. These tests do not use a Steam key. CI runs core checks on Linux, Windows and macOS, plus browser E2E on Linux.

`package` builds the native desktop download into `release/` without publishing it. `VAPORA_DESKTOP=/path/to/packaged/executable VAPORA_DESKTOP_ASAR=/path/to/resources/app.asar npm run test:desktop` checks its bundled files, launches it with fresh storage, completes a fixture scan, downloads its exports and closes its native window. Windows CI also launches the actual portable EXE, moves it with its data, reopens the saved run and downloads its exports again. Linux CI runs that command under Xvfb. Desktop builds exclude local keys, data and development dependencies.

The app shares its scanner, analysis and storage across CLI, browser and desktop. See the [product contract](product-contract.md), [E2E report](e2e-verification.md) and [release runbook](release-runbook.md). Live Steam verification is currently bounded to five accounts; it does not establish large-network behavior.

