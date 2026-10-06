# vapora

Explore public Steam friend networks from a local browser UI or the command line. Vapora scans friendships, computes graph metrics, ranks observed friend signals, and exports files for Gephi.

The TypeScript + Effect rewrite replaces the unfinished Python app. The original code and Windows executable remain on the [`legacy` branch](https://github.com/Microck/vapora/tree/legacy). The UI uses the classic Steam styling from the [`feature/gui-and-analysis` prototype](https://github.com/Microck/vapora/tree/feature/gui-and-analysis), with responsive panels and working controls.

## start

Install [Node.js 24 or newer](https://nodejs.org/), then:

```sh
git clone https://github.com/Microck/vapora.git
cd vapora
npm ci
npm run build
npm start
```

Open the local URL printed in the terminal. The server binds to `127.0.0.1`; use the printed address rather than `localhost`. It does not expose the app to your network.

Run it on a trusted local machine. Native programs and other accounts on that machine can access the session. Host and Origin checks protect against cross-origin browser requests.

Get a [Steam Web API key](https://steamcommunity.com/dev/apikey). Open **API key** and enter it for the current server session, or copy `.env.example` to `.env` and set `STEAM_API_KEY`. Environment keys also work. The browser does not store keys, and keys never appear in exports.

In **Scan**, choose a target, preset, and optional signals, then scan. Completed and saved runs open in **Results**. Import normalized history files in **History**. Switching views keeps your inputs; active progress and cancellation remain visible across views. Targets can be SteamID64, SteamID2, `[U:1:ID]`, a Steam profile URL, or a vanity name. SteamID64 values stay strings to avoid precision loss.

Use `/id/NAME` for numeric vanity names. `/profiles/ID` and bare numbers identify Steam accounts by SteamID64.

## scanning

- **Inner circle:** depth 1, cap 300. Includes the target and admitted direct friends.
- **Community map:** depth 2, cap 500. Adds admitted friends of friends.
- **Custom:** depth 1–3, cap 1–1000, 1–120 requests per minute, ranking weights, and a hub percentile.

Vapora queries admitted boundary profiles for ranking signals without expanding past the configured depth. Every request is paced. Temporary transport failures, rate limits, and selected server failures get up to three retries. Private friend lists remain distinct from empty public lists.

Cancel saves a checkpoint. Resume uses the original target, settings, and unfinished frontier. Failed scans also preserve their checkpoint. A stopped server can leave a run marked `running`; after restarting, open that run and resume it. Checkpoints use the current Vapora 2 format; Python outputs are preserved separately and are not migrated.

Owned-game overlap uses public library data. Group links are optional and disabled by default because Steam's documented group endpoint requires publisher access. Denied membership lookup appears as unavailable and stops further group requests in that operation.

Saved profiles contain settings only. Recent runs, profiles, and exports stay under the working directory, or the directory selected with `--root`.

## command line

```sh
npm start -- scan 'https://steamcommunity.com/id/example' --preset inner
npm start -- estimate '76561198000000000' --depth 2
npm start -- scan '76561198000000000' --games --max-nodes 200
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

The CLI scanner needs `STEAM_API_KEY` in your environment or `.env`. History import, report rebuilding, and profile commands work without a key. Estimates sample at most five friend lists; they are approximate and respect the node cap. Depth 3 estimates describe only the first two levels.

## reports and exports

Each run has a unique folder:

```text
outputs/<run-id>/
  scan.json
  analysis.json
  probable-friends.csv
  run.log
  gephi/nodes.csv
  gephi/edges.csv
  history.json          # when attached
```

The browser shows ranked friends, location signals, a static interactive graph, and download links. It supports cancellation, resume, filtering, graph zoom, node inspection, profiles, and history imports. No placeholder results or looping animations.

Graph metrics include degree, normalized betweenness, Louvain communities, and hubs at the configured percentile. Metrics use admitted friendship edges. Shared-group edges remain separate, so group co-membership does not inflate friendship centrality. Zero-centrality graphs have no hubs.

Friend ranking uses weighted mutual count, neighbor-set Jaccard, shared groups, and shared games. The evidence score scales the highest observed score to 100. Missing observations remain unknown. A private list can still have observed mutuals from another public list.

Location signals group self-reported country, state, and city codes among admitted direct friends. Each contribution has weight `1 + observed mutuals`; the report shows its share of the available location signal.

**These scores do not measure real-life friendship or the target's residence.** Steam locations are self-reported. Privacy, depth, and node caps affect coverage. Every report includes coverage and relevant warnings.

CSV uses proper quoting for commas, quotes, and newlines. Untrusted formula-like text gets a leading apostrophe for spreadsheet imports. Steam IDs remain strings in JSON; configure spreadsheet ID columns as text.

### Gephi

1. Create a project and import `gephi/nodes.csv` as a nodes table.
2. Import `gephi/edges.csv` as undirected edges.
3. Filter `Kind` to `friend` to inspect the friendship graph, or include `group` for shared membership.
4. Use ForceAtlas2, color by `modularity_class`, and size by `betweenness` or `degree`.

## SteamHistory imports

Import a local normalized JSON file in the UI, or use `history FILE`. Vapora does not scrape SteamHistory or fetch arbitrary URLs. Expected input:

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

Dates are Unix seconds. An absent or zero `UnfriendDate` means still friends at `lastChecked`. Invalid time ranges fail visibly. Overlapping intervals count once. NDJSON must contain normalized snapshots of the same account; Vapora selects the latest `lastChecked` snapshot. Profile and history details remain in the report. Friendship duration stays separate from network evidence scores.

Attaching history requires its Steam account to match the selected run. Otherwise import it independently. Browser imports accept files up to 2 MB.

## development

```sh
npm ci
npm run verify
npm run dev
```

The checks run TypeScript, Oxlint with anti-slop rules and a complexity limit, then domain and integration tests. Tests use real local HTTP fixtures and real filesystem storage. They do not need a Steam key or make Steam requests. CI runs on Linux, Windows, and macOS.

`src/model.ts` owns settings and checkpoint schemas. `src/steam.ts` owns provider decoding, pacing, and retries. `src/scanner.ts` owns scanning and resume. `src/analysis.ts` owns deterministic reports. `src/storage.ts` owns atomic writes and path boundaries. The CLI and local server call that shared core. Browser responses use the shared schemas in `src/contracts.ts`.

The product contract is in [docs/product-contract.md](docs/product-contract.md). Steam behavior follows the official [ISteamUser](https://partner.steamgames.com/doc/webapi/ISteamUser), [IPlayerService](https://partner.steamgames.com/doc/webapi/IPlayerService), and [Web API overview](https://partner.steamgames.com/doc/webapi_overview) documentation.

See [verification results and browser screenshots](docs/verification.md) for the tested workflows and live-Steam verification limit.

## troubleshooting

- **Access denied:** check your API key. Group access may require publisher permissions.
- **Private friend list:** Steam returns no accessible list. Vapora cannot bypass privacy settings.
- **Failed scan:** fix the reported provider, disk-space, or permission issue and resume the saved run.
- **Invalid checkpoint:** start a new run. Legacy Python checkpoints use a different format.
- **Long scans:** reduce depth, the node cap, or optional library/group requests. Public data collection remains limited by the configured request rate.
- **Port in use:** choose another port with `npm start -- serve --port 3001`.

MIT. See [LICENSE](LICENSE).
