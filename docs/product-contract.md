# Vapora 2 contract

Vapora runs locally on Node.js 24 and uses TypeScript and Effect 4. The Python implementation stays on the remote `legacy` branch. The rewrite has one scan and report format. It does not read legacy checkpoints.

## Required behavior

- Accept individual SteamID64, SteamID2, SteamID3, Steam community profile URLs, and vanity names. `/id/` URL segments always identify vanity names, including numeric names; `/profiles/` segments identify SteamID64. Reject other hosts, malformed IDs, and unsupported account types before scanning.
- Offer inner-circle and community presets, validated custom configuration, and named saved profiles.
- Scan public friendship networks breadth first to the configured depth and hard node cap. Depth 1 includes the seed and its direct friends. Query admitted boundary nodes for analysis, without admitting nodes beyond the limit.
- Distinguish private/unavailable friend lists from empty public lists. Keep admitted profiles even when private. A bad API key, exhausted retry, or malformed provider payload must fail visibly.
- Pace every API request, retry only transient read failures with a bounded policy, honor bounded Retry-After delays, and interrupt in-flight requests when cancelled.
- Send the required `OpenAI File Downloader, XaiImageApiFetch/1.0` user-agent on Steam requests.
- Save atomic checkpoints after completed scan units. Resume the exact frontier, settings, and seed without reprocessing completed units. Cancelled or failed runs remain resumable. A hard cap must not leave dangling graph edges.
- Verify API authority at the start of each scan or resume. Keep a returned-but-missing ban record distinct from a record that has not been requested.
- Diagnose damaged saved runs individually while continuing to list healthy runs and allowing new scans. Never repair or delete damaged files automatically.
- Fetch summary and ban information in batches of at most 100. Optional owned-game overlap and shared-group links must use real provider data and expose denied or unavailable access.
- Export canonical `scan.json`, `analysis.json`, `probable-friends.csv`, `gephi/nodes.csv`, `gephi/edges.csv`, and timestamped `run.log` under a unique run directory. Escape CSV fields correctly and prevent spreadsheet formulas in untrusted text fields.
- Compute degree, normalized betweenness, deterministic Louvain communities, and percentile-based hubs. Treat friendships as undirected; group links remain a distinct kind. Graph metrics use friendship edges, so group co-membership does not distort friendship centrality.
- Rank direct friends with configurable mutual, Jaccard, shared-group, and shared-game signals. Explain missing observations and graph truncation. Display friend and location estimates as heuristic scores, never calibrated real-world probabilities.
- Support local normalized SteamHistory JSON and NDJSON imports with validated timestamps and individual Steam IDs. Preserve profile/history details and rank friendship durations separately from network scores.
- Provide a CLI with scan, estimate, resume, history, analyze, serve, profiles, and recent-run operations. Estimates are labeled sampling estimates and bounded by the cap.
- Provide a working local browser UI for configuration, estimation, scanning, cancellation, resume, reports, graph exploration, imports, saved profiles, and export downloads. Render names as text, support keyboard navigation, show actual progress, and retain UI state through polling.
- Polish the existing `feature/gui-and-analysis` composition: compact toolbar, scan parameters above mode/output on the left, and target/profile/actions on the right. Use its classic Steam olive surfaces, inset fields, beveled controls, compact type, and mustard selection accents. Keep one stylesheet, visible focus and scrollbars, and no looping animation.
- Size the Steam window to its content. Keep recent-run lists bounded, avoid stretching empty panels, and put format help and method notes behind native disclosures. Keep run failures visible.
- Use `assets/vapora.svg`, traced from the existing Vapora eye and wordmark, with transparent surroundings, outlined letters, and the original blue gradients. The SVG contains vector paths, not an embedded raster or runtime font. Preserve the source PNG and existing favicon. Bundle local visual assets and serve them through an explicit allowlist. A target preview must not invent profile data or imply that an unscanned profile has been resolved.
- Separate Scan, Results, History, and Connection views. Switching views preserves inputs and reports; opening a saved or completed run shows Results unless the user navigates elsewhere while it loads. Progress and cancellation stay accessible in every view. Stack the layout at narrow widths without page-level horizontal overflow.
- Give each scan/resume operation a unique operation ID, independent of its run ID and server instance. Process each terminal result once, including repeated failures before creating a run and repeated cancellation of the same run.
- Show actionable failure messages in the browser and saved report; keep stack traces in the run log.
- Bind the browser server to loopback, validate Host and mutation origins, keep API keys out of report files and browser responses, and restrict file downloads to known run artifacts.
- Run automated domain, provider, persistence, CLI, and HTTP integration checks against real local fixtures. Run browser checks at desktop and narrow widths. CI verifies the locked dependency install, types, lint, and tests.
- Keep CI checkout credentials out of subsequent dependency and project execution. Enforce safety comments for assertions, including comments before exported declarations.

## Analysis limits

Steam profiles and friend lists can have different privacy settings. Unavailable observations do not count as known empty sets. Friendships outside the admitted graph can affect ranking signals but not graph metrics. Report coverage explicitly. Location fields are self-reported Steam country/state/city codes, not verified residence. Public group lookup may require publisher permissions. Imported SteamHistory data is supplied by the operator; Vapora does not scrape SteamHistory or fetch arbitrary URLs.
