import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { strToU8, zipSync } from "fflate";
import type { RunView } from "./contracts.js";
import type { SteamId } from "./model.js";

// Provider text is content, never Markdown structure, HTML or a note filename.
const text = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replace(/[\\`*_{}[\]()!#|]/g, "\\$&").replace(/[\r\n]+/g, " ");
const date = (seconds: number | null) => seconds === null ? "Unknown" : new Date(seconds * 1000).toISOString();
const value = (number: number | null | undefined) => number === null || number === undefined ? "Unknown" : String(number);

function collect({ scan, report, history }: RunView) {
  const names = new Map(scan.players.map((player) => [player.id, player.name]));
  if (!names.has(scan.seed)) names.set(scan.seed, scan.seed);
  for (const friend of report.friends) if (!names.has(friend.id)) names.set(friend.id, friend.name);
  for (const friend of history?.friends ?? []) if (!names.has(friend.id)) names.set(friend.id, friend.name);
  for (const author of history?.commenters ?? []) if (author.id && !names.has(author.id)) names.set(author.id, author.name);
  const link = (id: SteamId) => {
    const name = names.get(id) ?? id;
    // Wiki-link delimiters cannot be escaped inside an alias with Markdown backslashes.
    const alias = name.replace(/[[\]|#\r\n]/g, " ").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `[[Profiles/${id}|${alias}]]`;
  };
  const friendships = new Map<SteamId, Set<SteamId>>();
  const groups = new Map<SteamId, Set<SteamId>>();
  const connect = (links: Map<SteamId, Set<SteamId>>, left: SteamId, right: SteamId) => {
    const neighbors = links.get(left) ?? new Set<SteamId>(); neighbors.add(right); links.set(left, neighbors);
  };
  for (const edge of report.edges) {
    const links = edge.kind === "friend" ? friendships : groups;
    connect(links, edge.source, edge.target); connect(links, edge.target, edge.source);
  }
  // Keep observed direct friends outside the capped graph, without inventing their other links.
  for (const friend of report.friends) { connect(friendships, scan.seed, friend.id); connect(friendships, friend.id, scan.seed); }
  return { names, link, friendships, groups };
}
type Notes = ReturnType<typeof collect>;

function properties(run: string, id: SteamId, name: string, player: RunView["scan"]["players"][number] | undefined) {
  return [
    "---", `steam_id: ${JSON.stringify(id)}`, `name: ${JSON.stringify(name)}`, `aliases: [${JSON.stringify(name)}]`,
    `run_id: ${JSON.stringify(run)}`, `admitted: ${Boolean(player)}`,
    `profile: ${JSON.stringify(player?.visibility ?? "unknown")}`,
    `friend_list: ${JSON.stringify(player?.friendsStatus ?? "unknown")}`,
    `vac_bans: ${player?.bans?.vacCount ?? "null"}`, "---", "",
  ];
}

function observations(player: RunView["scan"]["players"][number] | undefined, metric: RunView["report"]["metrics"][number] | undefined,
  rank: RunView["report"]["friends"][number] | undefined) {
  return [
    `- Collection: ${player ? `depth ${player.level}` : "Outside admitted graph"}`,
    `- Friend list as of: ${text(player?.friendsObservedAt ?? "Unknown")}`,
    `- Ban records as of: ${text(player?.bansObservedAt ?? "Unknown")}`,
    `- VAC bans: ${value(player?.bans?.vacCount)}`, `- Game bans: ${value(player?.bans?.game)}`,
    `- Degree: ${value(metric?.degree)}`, `- Betweenness: ${value(metric?.betweenness)}`,
    `- Community: ${metric ? metric.community + 1 : "Unknown"}`, `- Hub: ${metric ? metric.hub ? "Yes" : "No" : "Unknown"}`,
    `- Incoming mutuals: ${value(rank?.incomingMutual)}`, `- Undirected mutuals: ${value(rank?.mutual)}`,
    `- Evidence / 100: ${value(rank?.evidenceScore)}`,
  ];
}

function profileNotes(view: RunView, notes: Notes, add: (name: string, lines: readonly string[]) => void) {
  const { scan, report, history } = view;
  const players = new Map(scan.players.map((player) => [player.id, player]));
  const metrics = new Map(report.metrics.map((metric) => [metric.id, metric]));
  const ranks = new Map(report.friends.map((friend) => [friend.id, friend]));
  const historicalFriends = new Map(history?.friends.map((friend) => [friend.id, friend]) ?? []);
  for (const [id, name] of [...notes.names].sort(([left], [right]) => left.localeCompare(right))) {
    const player = players.get(id); const metric = metrics.get(id); const rank = ranks.get(id);
    const historical = historicalFriends.get(id);
    const observed = [...notes.friendships.get(id) ?? []].sort().map((neighbor) => `- ${notes.link(neighbor)}`);
    const shared = [...notes.groups.get(id) ?? []].sort().map((neighbor) => `- ${notes.link(neighbor)}`);
    add(`Profiles/${id}.md`, [
      ...properties(scan.id, id, name, player),
      `# ${text(name)}`, "", `[Steam profile](https://steamcommunity.com/profiles/${id}/)`, "", "## Saved observations", "",
      ...observations(player, metric, rank), "", "## Observed friendships", "",
      ...(observed.length ? observed : ["No friendship links were observed in this run; this does not prove an empty friend list."]),
      ...(shared.length ? ["", "## Shared group links", "", ...shared] : []),
      ...(historical ? ["", "## Historical friendship", "", `- Status: ${historical.status}`,
        `- As of: ${date(historical.asOf)}`, `- Duration, seconds: ${value(historical.durationSeconds)}`,
        ...historical.conflicts.map((conflict) => `- ${text(conflict)}`)] : []),
      ...(id === scan.seed && history ? ["", "History: [[History]]"] : []), "", "Run: [[Vapora]]",
    ]);
  }
}

/** A vault is generated only from the saved run. Exporting never queries Steam or changes data. */
function buildVault(view: RunView): Uint8Array {
  const { scan, report, history, historyError } = view;
  const notes = collect(view); const { names, link } = notes;
  const files: Record<string, Uint8Array> = {};
  const add = (name: string, lines: readonly string[]) => { files[name] = strToU8(lines.join("\n") + "\n"); };
  const warnings = [...report.warnings, ...(scan.error ? [scan.error] : []), ...(historyError ? [historyError] : [])];
  add("Vapora.md", [
    "# Vapora", "", `Target: ${link(scan.seed)}`, `Run: ${scan.id}`, `Collected: ${text(scan.updatedAt)}`,
    `Status: ${scan.status}${scan.truncated ? "; node cap reached" : ""}`, "",
    "Extract this ZIP into a folder and open it as an Obsidian vault, or copy its notes into an existing vault. No plugin is required.", "",
    "## Coverage", "", `- Admitted profiles: ${report.coverage.nodes}`,
    `- Direct friends included: ${report.coverage.admittedDirectFriends}/${report.coverage.directFriends}`,
    `- Public friend lists: ${report.coverage.publicLists}`, `- Private friend lists: ${report.coverage.privateLists}`,
    `- Unavailable friend lists: ${report.coverage.unavailableLists}`, `- Skipped friend lists: ${report.coverage.skippedLists}`,
    `- Pending friend lists: ${report.coverage.pendingLists}`, "", "## Limits", "", ...warnings.map((warning) => `- ${text(warning)}`), "",
    "Links describe observed Steam friendships or shared groups. Missing data does not establish absence, and scores are not friendship probabilities.", "",
    ...(history ? ["Dated observations: [[History]]", ""] : []),
    "## Profiles", "", ...[...names.keys()].sort().map((id) => `- ${link(id)}`),
  ]);
  profileNotes(view, notes, add);
  if (history) {
    add("History.md", [
      "# Account history", "", `Account: ${link(scan.seed)}`, `Source as of: ${date(history.profile.lastChecked)}`, "",
      ...history.warnings.map((warning) => `- ${text(warning)}`), "", "## Historical friendships", "",
      ...history.friends.map((friend) => `- ${link(friend.id)}: ${friend.status}; observed ${date(friend.asOf)}; duration ${value(friend.durationSeconds)} seconds`),
      "", "## Captured comments", "", ...history.comments.flatMap((comment) => [
        `### ${date(comment.timestamp)}`, "", `Author: ${comment.author ? link(comment.author) : "Unknown"}`,
        `Captured occurrences: ${comment.occurrences}${comment.estimated ? " (estimated)" : ""}`, "",
        ...comment.message.split(/\r?\n/).map((line) => `> ${text(line)}`), "",
      ]), "", "Run: [[Vapora]]",
    ]);
  }
  return zipSync(files, { level: 6 });
}

// Building and compressing an uncapped vault must not block scan cancellation or state polling.
export function vault(view: RunView): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./obsidian.js", import.meta.url), { workerData: view });
    worker.once("message", resolve); worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`Vault export worker exited before returning a download (${code}).`)));
  });
}

if (!isMainThread && parentPort) {
  const archive = Uint8Array.from(buildVault(workerData));
  parentPort.postMessage(archive, [archive.buffer]);
}
