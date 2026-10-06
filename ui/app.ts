import { Effect, Schema } from "effect";
import { artifacts, defaults, Player, Ranking, Settings } from "../src/model.js";
import type { SteamId } from "../src/model.js";
import * as Contracts from "../src/contracts.js";
import { HistoryReport } from "../src/history.js";
import * as Network from "./network.js";

declare global {
  interface Window {
    vaporaDesktop?: {
      minimize: () => Promise<void>; maximize: () => Promise<void>; close: () => Promise<void>;
      openOutputs: (id: string | null) => Promise<void>;
    };
  }
}

const get = (id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found;
};
const control = (id: string) => {
  const found = get(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`Expected input: ${id}`);
  return found;
};
const select = (id: string) => {
  const found = get(id);
  if (!(found instanceof HTMLSelectElement)) throw new Error(`Expected select: ${id}`);
  return found;
};
const buttons = (id: string) => {
  const found = get(id);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Expected button: ${id}`);
  return found;
};
const inputs = {
  target: control("target"), depth: control("depth"), nodes: control("maxNodes"), rpm: control("rpm"), groups: control("groups"), games: control("games"), skipPrivate: control("skip-private"), hub: control("hub"),
  mutual: control("mutualWeight"), jaccard: control("jaccardWeight"), groupWeight: control("groupWeight"), gameWeight: control("gameWeight"),
  runSearch: control("run-search"), networkSearch: control("network-search"),
  key: control("key"), name: control("profile-name"), search: control("friend-search"), file: control("history-file"), attach: control("attach-history"),
};
const profiles = select("profiles"); const edgeKind = select("edge-kind");
const OutputMode = Schema.Literals(["all", "report", "gephi"]);
let outputMode: typeof OutputMode.Type = "all";
let preview: Player | null = null;
let previewTarget = "";
let selected: Contracts.RunView | null = null;
// Only replace a target with its resolved seed while the submitted text is still unchanged.
let linkedTarget = "";
let currentState: Contracts.State | null = null;
let recentSignature = "";
let profileSignature = "";
let lastJob: string | null = null;
let selectedNode: SteamId | null = null;
let runRequest = 0;
let runSignature = "";
let zoom = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let settingsVersion = 0;
const Screen = Schema.Literals(["scan", "results", "history", "settings"]);
let navigationVersion = 0;

/** Keep view contents mounted so navigation preserves forms, reports, and keyboard state. */
function showScreen(name: typeof Screen.Type) {
  navigationVersion++;
  for (const screen of document.querySelectorAll<HTMLElement>(".screen")) screen.hidden = screen.id !== `${name}-screen`;
  for (const tab of document.querySelectorAll<HTMLElement>(".toolbar [data-screen]")) {
    if (tab.dataset.screen === name) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  get("results").scrollTo({ top: 0, behavior: "instant" });
}

function notice(message: string) { get("notice").textContent = message; get("notice").hidden = !message; }
function task(action: () => Promise<void>) {
  notice("");
  void action().catch((error) => notice(error instanceof Error ? error.message : "The action failed."));
}
async function api<T, P = never>(path: string, schema: Schema.ConstraintDecoder<T>, payload?: P) {
  const response = await fetch(path, payload === undefined ? { headers: { accept: "application/json" } } : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const json: unknown = await response.json();
  if (!response.ok) {
    const failure = Schema.decodeUnknownSync(Contracts.Failure)(json);
    throw new Error(failure.error);
  }
  return await Effect.runPromise(Schema.decodeUnknownEffect(schema)(json));
}
const readSettings = () => Schema.decodeUnknownSync(Settings)({
  depth: Number(inputs.depth.value), maxNodes: inputs.nodes.valueAsNumber, requestsPerMinute: inputs.rpm.valueAsNumber,
  includeGroups: inputs.groups.checked, includeGames: inputs.games.checked, hubPercentile: inputs.hub.valueAsNumber,
  skipPrivate: inputs.skipPrivate.checked,
  weights: { mutual: inputs.mutual.valueAsNumber, jaccard: inputs.jaccard.valueAsNumber, groups: inputs.groupWeight.valueAsNumber, games: inputs.gameWeight.valueAsNumber },
});
function applySettings(settings: Settings) {
  get("estimate-result").textContent = "";
  inputs.depth.value = String(settings.depth); inputs.nodes.value = String(settings.maxNodes); inputs.rpm.value = String(settings.requestsPerMinute);
  inputs.groups.checked = settings.includeGroups; inputs.games.checked = settings.includeGames; inputs.hub.value = String(settings.hubPercentile);
  inputs.skipPrivate.checked = settings.skipPrivate;
  inputs.mutual.value = String(settings.weights.mutual); inputs.jaccard.value = String(settings.weights.jaccard);
  inputs.groupWeight.value = String(settings.weights.groups); inputs.gameWeight.value = String(settings.weights.games);
  renderDepth();
}
function renderDepth() {
  for (const button of document.querySelectorAll<HTMLElement>("[data-depth]")) button.setAttribute("aria-pressed", String(button.dataset.depth === inputs.depth.value));
}
/** A missing or failed Steam image keeps the same square placeholder, without repeated retries. */
function setAvatar(image: HTMLImageElement, url: string | null) {
  image.onerror = url ? () => { image.onerror = null; image.src = "/placeholder.jpg"; } : null;
  image.referrerPolicy = "no-referrer"; image.alt = ""; image.src = url ?? "/placeholder.jpg";
}
function avatarImage(url: string | null) {
  const image = document.createElement("img"); image.className = "profile-avatar"; image.width = 24; image.height = 24;
  setAvatar(image, url); return image;
}
function profileImage(id: string, url: string | null) {
  const image = get(id);
  if (!(image instanceof HTMLImageElement)) throw new Error(`Expected image: ${id}`);
  setAvatar(image, url);
}
/** Clear the identity immediately when the target no longer matches the selected run. */
function renderTarget() {
  const seed = selected?.scan.seed;
  const target = inputs.target.value.trim();
  const matches = seed && (target === seed || target === `https://steamcommunity.com/profiles/${seed}` || target === `https://steamcommunity.com/profiles/${seed}/`);
  const player = matches ? selected?.scan.players.find((player) => player.id === seed) : preview && (target === previewTarget || target === preview.id) ? preview : undefined;
  get("target-name").textContent = player?.name ?? "";
  profileImage("target-avatar", player?.avatar ?? null);
  get("target-id").textContent = player?.id ?? "";
  get("target-id").hidden = !player;
}
function cell(row: HTMLTableRowElement, text: string | number) {
  const td = document.createElement("td"); td.textContent = String(text); row.append(td); return td;
}
function playerCell(row: HTMLTableRowElement, id: SteamId, name: string, avatar: string | null) {
  const td = cell(row, ""); const link = document.createElement("a"); link.className = "player-link"; link.append(avatarImage(avatar), document.createTextNode(name));
  link.href = `https://steamcommunity.com/profiles/${id}/`; link.target = "_blank"; link.rel = "noreferrer";
  link.title = `Steam ID ${id}`; link.setAttribute("aria-label", `${name}, Steam ID ${id}`); td.append(link);
  return td;
}
const number = (value: number | null, digits = 0) => value === null ? "unknown" : value.toFixed(digits);
function renderFriends() {
  const rows = get("friend-rows"); rows.replaceChildren();
  const query = inputs.search.value.toLowerCase().trim();
  const friends = selected?.report.friends.filter((friend) => friend.name.toLowerCase().includes(query) || friend.id.includes(query)) ?? [];
  const players = new Map(selected?.scan.players.map((player) => [player.id, player]));
  for (const friend of friends) {
    const row = document.createElement("tr"); const profile = playerCell(row, friend.id, friend.name, players.get(friend.id)?.avatar ?? null);
    const inspect = document.createElement("button"); inspect.type = "button"; inspect.className = "inspect-button"; inspect.textContent = "Details";
    inspect.setAttribute("aria-label", `Inspect ${friend.name}`); inspect.addEventListener("click", () => inspectNode(friend.id)); profile.append(inspect);
    cell(row, `${friend.evidenceScore.toFixed(1)} / 100`); cell(row, friend.mutual); cell(row, number(friend.jaccard, 3));
    cell(row, number(friend.sharedGroups)); cell(row, number(friend.sharedGames)); cell(row, friend.friendsStatus); rows.append(row);
  }
  get("friend-empty").hidden = friends.length > 0;
}
function renderLocations() {
  const rows = get("location-rows"); rows.replaceChildren();
  for (const location of selected?.report.locations ?? []) {
    const row = document.createElement("tr");
    for (const value of [location.country, location.state ?? "unknown", location.city ?? "unknown", location.contributors, `${location.share.toFixed(1)}%`]) cell(row, value);
    rows.append(row);
  }
  get("location-empty").hidden = Boolean(selected?.report.locations.length);
}
const downloads = artifacts.filter((file) => file !== "history.json");
function downloadLink(id: string, file: string) {
  const link = document.createElement("a"); link.textContent = `↓ ${file}`; link.href = `/api/download?${new URLSearchParams({ id, file })}`; return link;
}
/** Output selection changes only this tree. Every completed scan keeps all its artifacts. */
function renderOutput() {
  const tree = get("output-tree"); tree.replaceChildren();
  const heading = document.createElement("p"); heading.className = "output-root";
  const scan = selected?.scan;
  heading.textContent = scan ? `outputs/${scan.id}/` : "outputs/<run-id>/";
  if (scan) heading.title = `${scan.players.find((p) => p.id === scan.seed)?.name ?? scan.seed} · ${new Date(scan.createdAt).toLocaleString()}`;
  tree.append(heading);
  get("output-owner").textContent = scan ? scan.players.find((p) => p.id === scan.seed)?.name ?? scan.seed : "";
  const files = (selected?.history ? artifacts : downloads).filter((file) => file === "scan.json" || file === "run.log" || outputMode === "all" || (outputMode === "gephi" ? file.startsWith("gephi/") : !file.startsWith("gephi/")));
  for (const file of files) {
    const available = scan && (scan.status === "complete" || file === "scan.json" || file === "run.log" || file === "history.json");
    const row = available ? downloadLink(scan.id, file) : document.createElement("span");
    row.textContent = `${file === files.at(-1) ? "└─" : "├─"} ${file}`;
    tree.append(row);
  }
}
function renderReport() {
  if (!selected) return;
  const { scan, report } = selected;
  get("empty").hidden = true; get("report").hidden = !get("run-library").hidden;
  const target = scan.players.find((player) => player.id === scan.seed);
  get("report-name").textContent = target?.name ?? scan.seed;
  profileImage("report-avatar", target?.avatar ?? null);
  const profile = get("report-profile"); profile.setAttribute("href", `https://steamcommunity.com/profiles/${scan.seed}/`); profile.textContent = "Steam profile ↗";
  profile.title = `Steam ID ${scan.seed}`;
  get("report-status").textContent = scan.status;
  get("report-details").textContent = `${new Date(scan.createdAt).toLocaleString()} · Steam ID ${scan.seed} · depth ${scan.settings.depth} · cap ${scan.settings.maxNodes}`;
  buttons("resume-button").hidden = scan.status === "complete" || (currentState?.job.status === "running" && currentState.job.id === scan.id);
  const coverage = get("coverage"); coverage.replaceChildren();
  for (const [label, value] of [["Profiles", report.coverage.nodes], ["Friendships", report.edges.filter((e) => e.kind === "friend").length], ["Public friend lists", report.coverage.publicLists], ["Direct friends included", `${report.coverage.admittedDirectFriends}/${report.coverage.directFriends}`], ["Skipped lists", report.coverage.skippedLists], ["Unavailable lists", report.coverage.unavailableLists]] as const) {
    const group = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd");
    term.textContent = label; detail.textContent = String(value); group.append(term, detail); coverage.append(group);
  }
  renderCoverageNotice(); renderRanking();
  const warnings = get("warnings"); warnings.replaceChildren();
  get("report-error").textContent = scan.error; get("report-error").hidden = !scan.error;
  for (const warning of report.warnings) { const p = document.createElement("p"); p.textContent = warning; warnings.append(p); }
  const exports = get("downloads"); exports.replaceChildren();
  for (const file of selected.history ? artifacts : downloads) if (scan.status === "complete" || file === "scan.json" || file === "run.log" || file === "history.json") exports.append(downloadLink(scan.id, file));
  renderFriends(); renderLocations(); renderGraph(); renderTarget(); renderOutput();
}
function renderCoverageNotice() {
  if (!selected) return;
  const { scan, report } = selected;
  const missing = report.coverage.unavailableLists; const skipped = report.coverage.skippedLists;
  const partial = scan.status !== "complete" || scan.truncated || missing > 0 || skipped > 0;
  const warning = get("coverage-warning"); warning.hidden = !partial;
  warning.textContent = `Partial results${scan.truncated ? " · node cap reached" : ""} · ${skipped} skipped · ${missing} unavailable friend lists. Counts describe observed data.`;
  get("open-history").hidden = !selected.history;
}
function renderRanking() {
  if (!selected) return;
  const { scan } = selected;
  const ranking = scan.settings;
  control("ranking-hub").value = String(ranking.hubPercentile);
  for (const name of ["mutual", "jaccard", "groups", "games"] as const) control(`ranking-${name}`).value = String(ranking.weights[name]);
  buttons("save-ranking").disabled = scan.status !== "complete" || currentState?.job.status === "running";
}
function inspectNode(id: SteamId) {
  selectedNode = id; renderInspector(); renderGraph();
}
function renderInspector() {
  const player = selected?.scan.players.find((p) => p.id === selectedNode);
  const metric = selected?.report.metrics.find((m) => m.id === selectedNode);
  get("profile-inspector").hidden = !player;
  if (!player) return;
  get("inspect-name").textContent = player.name; profileImage("inspect-avatar", player.avatar);
  get("inspect-link").setAttribute("href", `https://steamcommunity.com/profiles/${player.id}/`);
  get("inspect-link").textContent = player.id; get("inspect-link").title = "Open Steam profile";
  const facts = get("inspect-facts"); facts.replaceChildren();
  const bans = player.bans;
  const fields: readonly (readonly [string, string | number])[] = [
    ["Depth", player.level], ["Profile", player.visibility], ["Friend list", player.friendsStatus],
    ["Groups", player.groupsStatus === "public" ? player.groups.length : player.groupsStatus],
    ["Games", player.gamesStatus === "public" ? player.games.length : player.gamesStatus],
    ["VAC ban", bans ? bans.vac ? "yes" : "no" : player.bansStatus],
    ["Game bans", bans ? bans.game : player.bansStatus], ["Community ban", bans ? bans.community ? "yes" : "no" : player.bansStatus],
    ["Degree", metric?.degree ?? "unknown"], ["Betweenness", metric?.betweenness.toFixed(4) ?? "unknown"],
    ["Community", metric ? metric.community + 1 : "unknown"], ["Hub", metric ? metric.hub ? "yes" : "no" : "unknown"],
  ];
  for (const [label, value] of fields) {
    const term = document.createElement("dt"); term.textContent = label; const detail = document.createElement("dd"); detail.textContent = String(value); facts.append(term, detail);
  }
}
function renderGraph() {
  const graph = get("graph");
  if (!(graph instanceof SVGSVGElement) || !selected) return;
  Network.render(graph, get("community-legend"), get("network-matches"), get("graph-count"), selected,
    { id: selectedNode, zoom, query: inputs.networkSearch.value, edges: edgeKind.value }, inspectNode);
}
function toggleRuns(visible: boolean) {
  get("run-library").hidden = !visible; buttons("toggle-runs").setAttribute("aria-expanded", String(visible));
  buttons("toggle-runs").textContent = visible && selected ? "Back to report" : "Saved runs";
  get("report").hidden = visible || !selected; get("empty").hidden = visible || Boolean(selected);
}
function renderRuns() {
  if (!currentState) return;
  const query = inputs.runSearch.value.trim().toLowerCase(); const status = select("run-status").value;
  const signature = JSON.stringify([currentState.runs, currentState.runIssues, query, status]);
  if (signature === runSignature) return;
  runSignature = signature;
  const rows = get("run-rows"); rows.replaceChildren();
  const runs = currentState.runs.filter((run) => (status === "all" || status === run.status) &&
    `${run.name} ${run.seed} ${run.id}`.toLowerCase().includes(query));
  for (const run of runs) {
    const row = document.createElement("tr"); const name = cell(row, ""); const button = document.createElement("button");
    button.type = "button"; button.className = "run-link"; button.append(avatarImage(run.avatar), document.createTextNode(run.name));
    button.addEventListener("click", () => task(() => openRun(run.id))); name.append(button);
    cell(row, new Date(run.createdAt).toLocaleString()); cell(row, run.status === "running" ? "unfinished" : run.status); cell(row, run.nodes); cell(row, run.id); rows.append(row);
  }
  get("run-empty").hidden = runs.length > 0;
  const issues = get("run-issues"); issues.replaceChildren();
  for (const issue of currentState.runIssues) {
    const warning = document.createElement("p"); warning.textContent = `${issue.id}: ${issue.message}`; issues.append(warning);
  }
}
function renderHistory(report: HistoryReport, runId: string | null) {
  get("history-result").hidden = false; get("history-name").textContent = report.profile.name ?? report.profile.steamID64;
  get("history-warning").textContent = report.warning;
  const link = get("history-download"); link.hidden = !runId; if (runId) link.setAttribute("href", downloadLink(runId, "history.json").href);
  const rows = get("history-rows"); rows.replaceChildren();
  const players = new Map(selected?.scan.players.map((player) => [player.id, player]));
  for (const friend of report.friends) {
    const row = document.createElement("tr"); playerCell(row, friend.id, friend.name, players.get(friend.id)?.avatar ?? null);
    cell(row, `${Math.floor(friend.durationSeconds / 86400)} days`); cell(row, `${friend.relativeDuration.toFixed(1)}%`); cell(row, friend.currentlyFriends ? "yes" : "no"); rows.append(row);
  }
}
async function openRun(id: string, navigation = navigationVersion) {
  const request = ++runRequest;
  const view = await api(`/api/runs/${encodeURIComponent(id)}`, Contracts.RunView);
  if (request !== runRequest) return;
  selected = view;
  const typed = inputs.target.value.trim();
  if (!typed || typed === linkedTarget) { inputs.target.value = selected.scan.seed; linkedTarget = selected.scan.seed; }
  selectedNode = null; zoom = 1; inputs.networkSearch.value = ""; renderInspector(); toggleRuns(false);
  location.hash = id; renderReport(); renderRecent();
  // A report response must not override a navigation choice made while it loaded.
  if (navigation === navigationVersion) {
    showScreen("results");
    get("results").focus({ preventScroll: true });
  }
}
function renderRecent() {
  const signature = JSON.stringify([currentState?.runs, currentState?.runIssues, selected?.scan.id]);
  if (signature === recentSignature) return;
  recentSignature = signature; const recent = get("recent"); recent.replaceChildren();
  const runs = currentState?.runs ?? [];
  const issues = currentState?.runIssues ?? [];
  for (const run of runs) {
    const button = document.createElement("button"); button.type = "button";
    button.append(avatarImage(run.avatar));
    button.setAttribute("aria-current", String(selected?.scan.id === run.id));
    button.title = `${run.status} · ${run.nodes} profiles · ${new Date(run.createdAt).toLocaleString()}`;
    button.setAttribute("aria-label", `${run.name}, ${button.title}`);
    button.addEventListener("click", () => task(() => openRun(run.id))); recent.append(button);
  }
  for (const issue of issues) {
    const button = document.createElement("button"); button.type = "button"; button.append(avatarImage(null));
    button.title = `Invalid run ${issue.id}`; button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => notice(issue.message)); recent.append(button);
  }
  const emptySlots = Math.max(0, 5 - runs.length - issues.length);
  for (let i = 0; i < emptySlots; i++) {
    const empty = avatarImage(null); empty.title = "No saved run"; empty.setAttribute("aria-hidden", "true"); recent.append(empty);
  }
  if (runs.length + issues.length === 0) {
    const status = document.createElement("span"); status.className = "sr-only"; status.textContent = "No saved runs."; recent.append(status);
  }
}
function renderProgress(state: Contracts.State) {
    get("key-status").textContent = state.hasKey ? "Key set for this session." : "Key required.";
    get("key-indicator").textContent = state.hasKey ? "Key ready" : "Key needed";
    get("key-indicator").dataset.key = state.hasKey ? "ready" : "missing";
    const running = state.job.status === "running";
    buttons("scan-button").disabled = running || !state.hasKey;
    buttons("estimate-button").disabled = running || !state.hasKey;
    buttons("resume-button").disabled = running || !state.hasKey;
    buttons("lookup-target").disabled = running || !state.hasKey;
    buttons("save-ranking").disabled = running || selected?.scan.status !== "complete";
    get("progress-section").hidden = !running;
    get("progress-title").textContent = state.job.progress?.phase ?? "Resolving profile";
    const progress = state.job.progress;
    get("progress-text").textContent = progress ? `${progress.scanned}/${progress.nodes} profiles scanned · ${progress.remaining} queued` : "Connecting to Steam";
    const bar = get("progress"); bar.setAttribute("max", String(Math.max(1, progress?.nodes ?? 1))); bar.setAttribute("value", String(progress?.scanned ?? 0));
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const navigation = navigationVersion;
  try {
    currentState = await api("/api/state", Contracts.State);
    if (lastJob === null && currentState.profiles.includes("default")) {
      const version = settingsVersion;
      const settings = await api("/api/profiles/default", Settings);
      if (version === settingsVersion) applySettings(settings);
    }
    get("connection").textContent = "Local session";
    renderProgress(currentState);
    renderRecent(); renderRuns();
    const signature = JSON.stringify(currentState.profiles);
    if (signature !== profileSignature) {
      profileSignature = signature; const value = profiles.value;
      profiles.replaceChildren(new Option("Choose profile", ""), ...currentState.profiles.map((name) => new Option(name, name))); profiles.value = value;
    }
    const job = currentState.job;
    // A startup snapshot is not a new result. Observe transitions by operation identity,
    // so a historical job cannot replace the saved run requested in the URL.
    const version = `${job.operationId}:${job.status}`;
    const changed = lastJob !== null && version !== lastJob;
    lastJob = version;
    if (job.status !== "running" && job.status !== "idle" && changed) {
      if (job.id) await openRun(job.id, navigation);
      if (job.error) notice(job.error);
    }
  } catch (error) {
    get("connection").textContent = "Disconnected";
    notice(error instanceof Error ? error.message : "Cannot reach the local server.");
  } finally {
    refreshing = false; clearTimeout(timer); timer = setTimeout(() => void refresh(), currentState?.job.status === "running" ? 1500 : 10000);
  }
}

get("scan-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  buttons("scan-button").disabled = true;
  const target = inputs.target.value;
  try { await api("/api/scan", Contracts.Ok, { target, settings: readSettings() }); linkedTarget = target.trim(); }
  finally { await refresh(); }
}); });
buttons("estimate-button").addEventListener("click", () => task(async () => {
  buttons("estimate-button").disabled = true;
  try {
    const estimate = await api("/api/estimate", Contracts.Estimate, { target: inputs.target.value, settings: readSettings() });
    get("estimate-result").textContent = estimate.available ? `${estimate.directFriends} direct friends · approximately ${estimate.estimatedNodes} admitted nodes · ${estimate.sampleSize} public samples. ${estimate.note ?? ""}` : estimate.note ?? "The friend list is private or unavailable. No estimate is possible.";
  } finally { await refresh(); }
}));
get("output-mode").addEventListener("change", (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  outputMode = Schema.decodeUnknownSync(OutputMode)(event.target.value); renderOutput();
});
get("scan-form").addEventListener("input", () => { settingsVersion++; get("estimate-result").textContent = ""; });
inputs.target.addEventListener("input", () => { preview = null; previewTarget = ""; get("estimate-result").textContent = ""; renderTarget(); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-depth]")) button.addEventListener("click", () => {
  settingsVersion++; inputs.depth.value = button.dataset.depth ?? "2"; renderDepth(); get("estimate-result").textContent = "";
});
buttons("lookup-target").addEventListener("click", () => task(async () => {
  if (!inputs.target.reportValidity()) return;
  const target = inputs.target.value.trim(); buttons("lookup-target").disabled = true;
  try {
    const player = await api("/api/target", Player, { target, settings: readSettings() });
    if (inputs.target.value.trim() === target) { preview = player; previewTarget = target; renderTarget(); }
  } finally { await refresh(); }
}));
buttons("apply-settings").addEventListener("click", () => task(async () => {
  if (!get("scan-form").querySelector<HTMLInputElement>(":invalid")) {
    await api("/api/profiles", Contracts.Ok, { name: "default", settings: readSettings() }); await refresh(); notice("Saved default settings.");
  } else throw new Error("Check the node limit and request rate.");
}));
get("key-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  await api("/api/key", Contracts.Ok, { key: inputs.key.value }); inputs.key.value = ""; await refresh();
}); });
get("profile-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  await api("/api/profiles", Contracts.Ok, { name: inputs.name.value, settings: readSettings() }); dialog("save-dialog").close(); await refresh();
}); });
buttons("load-profile").addEventListener("click", () => task(async () => {
  if (!profiles.value) throw new Error("Choose a saved profile first.");
  applySettings(await api(`/api/profiles/${encodeURIComponent(profiles.value)}`, Settings)); dialog("load-dialog").close();
}));
function dialog(id: string) {
  const found = get(id); if (!(found instanceof HTMLDialogElement)) throw new Error(`Expected dialog: ${id}`); return found;
}
const desktop = window.vaporaDesktop;
if (desktop) {
  document.body.classList.add("desktop"); get("window-controls").hidden = false;
  buttons("output-folder").textContent = "Open output folder";
  buttons("window-minimize").addEventListener("click", () => task(desktop.minimize));
  buttons("window-maximize").addEventListener("click", () => task(desktop.maximize));
  buttons("window-close").addEventListener("click", () => task(desktop.close));
}
buttons("output-folder").addEventListener("click", () => {
  if (desktop) task(() => desktop.openOutputs(selected?.scan.id ?? null));
  else {
    showScreen("results");
    if (selected) toggleRuns(false);
    document.querySelector<HTMLButtonElement>('[data-view="exports"]')?.click();
  }
});
buttons("save-settings").addEventListener("click", () => dialog("save-dialog").showModal());
buttons("open-settings").addEventListener("click", () => dialog("load-dialog").showModal());
for (const button of document.querySelectorAll<HTMLElement>("[data-close]")) button.addEventListener("click", () => dialog(button.dataset.close ?? "").close());
buttons("cancel-button").addEventListener("click", () => task(async () => { await api("/api/cancel", Contracts.Ok, {}); await refresh(); }));
buttons("resume-button").addEventListener("click", () => task(async () => { if (selected) { await api("/api/resume", Contracts.Ok, { id: selected.scan.id }); await refresh(); } }));
inputs.search.addEventListener("input", renderFriends);
for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-screen]")) {
  const screen = Schema.decodeUnknownSync(Screen)(tab.dataset.screen);
  tab.addEventListener("click", () => showScreen(screen));
}
for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-view]")) tab.addEventListener("click", () => {
  for (const other of document.querySelectorAll("[data-view]")) other.removeAttribute("aria-current");
  tab.setAttribute("aria-current", "page");
  for (const view of document.querySelectorAll<HTMLElement>(".view")) view.hidden = view.id !== `${tab.dataset.view}-view`;
});
inputs.runSearch.addEventListener("input", renderRuns); select("run-status").addEventListener("change", renderRuns);
inputs.networkSearch.addEventListener("input", renderGraph);
buttons("toggle-runs").addEventListener("click", () => toggleRuns(get("run-library").hidden));
buttons("close-inspector").addEventListener("click", () => { selectedNode = null; renderInspector(); renderGraph(); });
buttons("open-history").addEventListener("click", () => {
  if (selected?.history) { renderHistory(selected.history, selected.scan.id); showScreen("history"); }
});
get("ranking-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  if (!selected) return;
  const id = selected.scan.id;
  const ranking = Schema.decodeUnknownSync(Ranking)({ hubPercentile: control("ranking-hub").valueAsNumber,
    weights: { mutual: control("ranking-mutual").valueAsNumber, jaccard: control("ranking-jaccard").valueAsNumber, groups: control("ranking-groups").valueAsNumber, games: control("ranking-games").valueAsNumber } });
  buttons("save-ranking").disabled = true;
  try {
    const view = await api("/api/analyze", Contracts.RunView, { id, ranking });
    if (selected?.scan.id === id) { selected = view; renderReport(); renderInspector(); }
    notice("Saved ranking. Collected observations are unchanged.");
  } finally { await refresh(); }
}); });
edgeKind.addEventListener("change", renderGraph);
function renderZoom() {
  const graph = get("graph");
  if (graph instanceof SVGSVGElement && selected) Network.setZoom(graph, selected, zoom);
}
buttons("zoom-in").addEventListener("click", () => { zoom = Math.min(4, zoom * 1.25); renderZoom(); });
buttons("zoom-out").addEventListener("click", () => { zoom = Math.max(.5, zoom / 1.25); renderZoom(); });
buttons("zoom-reset").addEventListener("click", () => { zoom = 1; selectedNode = null; renderInspector(); renderGraph(); });
get("history-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  const file = inputs.file.files?.[0];
  if (!file) throw new Error("Choose a normalized history file.");
  if (file.size > 2 * 1024 * 1024) throw new Error("The file exceeds the 2 MB import limit.");
  if (inputs.attach.checked && !selected) throw new Error("Open a matching run before attaching history.");
  const runId = inputs.attach.checked ? selected?.scan.id : undefined;
  const report = await api("/api/history", HistoryReport, { contents: await file.text(), runId });
  renderHistory(report, runId ?? null);
  if (runId && selected?.scan.id === runId) { selected = { ...selected, history: report }; renderReport(); }

}); });
window.addEventListener("focus", () => void refresh());
applySettings(defaults);
renderTarget(); renderOutput();
const initialNavigation = navigationVersion;
void refresh().then(() => { const id = location.hash.slice(1); if (id && !selected) task(() => openRun(id, initialNavigation)); });
