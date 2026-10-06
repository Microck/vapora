import { Effect, Schema } from "effect";
import { artifacts, defaults, presets, Settings } from "../src/model.js";
import type { SteamId } from "../src/model.js";
import * as Contracts from "../src/contracts.js";
import { HistoryReport } from "../src/history.js";

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
  target: control("target"), depth: control("depth"), nodes: control("maxNodes"), rpm: control("rpm"), groups: control("groups"), games: control("games"), hub: control("hub"),
  mutual: control("mutualWeight"), jaccard: control("jaccardWeight"), groupWeight: control("groupWeight"), gameWeight: control("gameWeight"),
  key: control("key"), name: control("profile-name"), search: control("friend-search"), file: control("history-file"), attach: control("attach-history"),
};
const preset = select("preset"); const profiles = select("profiles"); const edgeKind = select("edge-kind");
let selected: Contracts.RunView | null = null;
let currentState: Contracts.State | null = null;
let recentSignature = "";
let profileSignature = "";
let lastJob = "";
let selectedNode: SteamId | null = null;
let zoom = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
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
  depth: inputs.depth.valueAsNumber, maxNodes: inputs.nodes.valueAsNumber, requestsPerMinute: inputs.rpm.valueAsNumber,
  includeGroups: inputs.groups.checked, includeGames: inputs.games.checked, hubPercentile: inputs.hub.valueAsNumber,
  weights: { mutual: inputs.mutual.valueAsNumber, jaccard: inputs.jaccard.valueAsNumber, groups: inputs.groupWeight.valueAsNumber, games: inputs.gameWeight.valueAsNumber },
});
function applySettings(settings: Settings) {
  inputs.depth.value = String(settings.depth); inputs.nodes.value = String(settings.maxNodes); inputs.rpm.value = String(settings.requestsPerMinute);
  inputs.groups.checked = settings.includeGroups; inputs.games.checked = settings.includeGames; inputs.hub.value = String(settings.hubPercentile);
  inputs.mutual.value = String(settings.weights.mutual); inputs.jaccard.value = String(settings.weights.jaccard);
  inputs.groupWeight.value = String(settings.weights.groups); inputs.gameWeight.value = String(settings.weights.games);
}
function cell(row: HTMLTableRowElement, text: string | number) {
  const td = document.createElement("td"); td.textContent = String(text); row.append(td); return td;
}
function playerCell(row: HTMLTableRowElement, id: SteamId, name: string) {
  const td = cell(row, ""); const link = document.createElement("a"); link.textContent = name;
  link.href = `https://steamcommunity.com/profiles/${id}/`; link.target = "_blank"; link.rel = "noreferrer";
  const small = document.createElement("small"); small.textContent = id; td.append(link, small);
}
const number = (value: number | null, digits = 0) => value === null ? "unknown" : value.toFixed(digits);
function renderFriends() {
  const rows = get("friend-rows"); rows.replaceChildren();
  const query = inputs.search.value.toLowerCase().trim();
  const friends = selected?.report.friends.filter((friend) => friend.name.toLowerCase().includes(query) || friend.id.includes(query)) ?? [];
  for (const friend of friends) {
    const row = document.createElement("tr"); playerCell(row, friend.id, friend.name);
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
function renderReport() {
  if (!selected) return;
  const { scan, report } = selected;
  get("empty").hidden = true; get("report").hidden = false;
  get("report-name").textContent = scan.players.find((player) => player.id === scan.seed)?.name ?? scan.seed;
  const profile = get("report-profile"); profile.setAttribute("href", `https://steamcommunity.com/profiles/${scan.seed}/`); profile.textContent = scan.seed;
  get("report-status").textContent = `${scan.status} · ${new Date(scan.createdAt).toLocaleString()} · depth ${scan.settings.depth} · cap ${scan.settings.maxNodes}`;
  buttons("resume-button").hidden = scan.status === "complete" || (currentState?.job.status === "running" && currentState.job.id === scan.id);
  const coverage = get("coverage"); coverage.replaceChildren();
  for (const [label, value] of [["Profiles", report.coverage.nodes], ["Friendships", report.edges.filter((e) => e.kind === "friend").length], ["Public friend lists", report.coverage.publicLists], ["Direct friends included", `${report.coverage.admittedDirectFriends}/${report.coverage.directFriends}`]] as const) {
    const group = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd");
    term.textContent = label; detail.textContent = String(value); group.append(term, detail); coverage.append(group);
  }
  const warnings = get("warnings"); warnings.replaceChildren();
  for (const warning of [scan.error, ...report.warnings].filter(Boolean)) { const p = document.createElement("p"); p.textContent = warning; warnings.append(p); }
  const exports = get("downloads"); exports.replaceChildren();
  for (const file of downloads) if (scan.status === "complete" || file === "scan.json" || file === "run.log") exports.append(downloadLink(scan.id, file));
  renderFriends(); renderLocations(); renderGraph();
}
function inspectNode(id: SteamId) {
  selectedNode = id;
  const player = selected?.scan.players.find((p) => p.id === id); const metric = selected?.report.metrics.find((m) => m.id === id);
  if (!player || !metric) return;
  get("node-detail").textContent = `${player.name} · ${id} · degree ${metric.degree} · betweenness ${metric.betweenness.toFixed(4)} · community ${metric.community} · friend list ${player.friendsStatus} · ${player.bans ? (player.bans.vac || player.bans.game || player.bans.community ? "bans recorded" : "no bans recorded") : "ban status unknown"}`;
  renderGraph();
}
function renderGraph() {
  const focusId = document.activeElement?.getAttribute("data-node-id");
  const graph = get("graph"); graph.replaceChildren();
  if (!selected) return;
  const positions = new Map<SteamId, { x: number; y: number }>();
  const metrics = [...selected.report.metrics].sort((a, b) => a.community - b.community || a.id.localeCompare(b.id));
  const players = new Map(selected.scan.players.map((player) => [player.id, player]));
  for (let i = 0; i < metrics.length; i++) {
    const metric = metrics[i]; if (!metric) continue;
    const angle = i * Math.PI * 2 / metrics.length;
    positions.set(metric.id, metric.id === selected.scan.seed ? { x: 500, y: 325 } : { x: 500 + Math.cos(angle) * 410, y: 325 + Math.sin(angle) * 260 });
  }
  const filtered = selected.report.edges.filter((edge) => edgeKind.value === "all" || edge.kind === edgeKind.value);
  const shown = selectedNode ? filtered.filter((edge) => edge.source === selectedNode || edge.target === selectedNode) : filtered;
  for (const edge of shown.slice(0, 1500)) {
    const from = positions.get(edge.source); const to = positions.get(edge.target); if (!from || !to) continue;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(from.x)); line.setAttribute("y1", String(from.y)); line.setAttribute("x2", String(to.x)); line.setAttribute("y2", String(to.y));
    line.setAttribute("stroke", edge.kind === "friend" ? "#758666" : "#9a895b"); graph.append(line);
  }
  const colors = ["#8abfff", "#a8dba8", "#e9b9e8", "#eed68b", "#99d9d9", "#e6ad95"];
  for (const metric of metrics) {
    const position = positions.get(metric.id); if (!position) continue;
    const name = players.get(metric.id)?.name ?? metric.id;
    const node = document.createElementNS("http://www.w3.org/2000/svg", "g");
    node.setAttribute("role", "button"); node.setAttribute("tabindex", "0"); node.setAttribute("aria-label", `${name}, degree ${metric.degree}`);
    node.setAttribute("data-node-id", metric.id);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(position.x)); circle.setAttribute("cy", String(position.y));
    circle.setAttribute("r", String(metric.id === selected.scan.seed ? 12 : Math.min(8, 4 + Math.sqrt(metric.degree) / 2)));
    circle.setAttribute("fill", colors[metric.community % colors.length] ?? "#fff");
    if (metric.id === selectedNode) { circle.setAttribute("stroke", "#fff"); circle.setAttribute("stroke-width", "3"); }
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title"); title.textContent = name;
    node.append(circle, title); node.addEventListener("click", () => inspectNode(metric.id));
    node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspectNode(metric.id); } }); graph.append(node);
    if (metric.id === focusId) node.focus();
  }
  graph.setAttribute("viewBox", `${500 - 500 / zoom} ${325 - 325 / zoom} ${1000 / zoom} ${650 / zoom}`);
  get("graph-count").textContent = `${metrics.length} nodes · ${Math.min(shown.length, 1500)}/${shown.length} edges drawn`;
}
async function openRun(id: string, navigation = navigationVersion) {
  selected = await api(`/api/runs/${encodeURIComponent(id)}`, Contracts.RunView);
  selectedNode = null; zoom = 1; get("node-detail").textContent = "Select a node.";
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
  for (const run of currentState?.runs ?? []) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = run.name;
    button.setAttribute("aria-current", String(selected?.scan.id === run.id));
    const small = document.createElement("small"); small.textContent = `${run.status} · ${run.nodes} nodes · ${new Date(run.createdAt).toLocaleString()}`;
    button.append(small); button.addEventListener("click", () => task(() => openRun(run.id))); recent.append(button);
  }
  for (const issue of currentState?.runIssues ?? []) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = `Invalid run ${issue.id}`;
    button.addEventListener("click", () => notice(issue.message)); recent.append(button);
  }
  if (!currentState?.runs.length && !currentState?.runIssues.length) { const p = document.createElement("p"); p.textContent = "No saved runs yet."; p.className = "hint"; recent.append(p); }
}
function renderProgress(state: Contracts.State) {
    get("key-status").textContent = state.hasKey ? "Key available. Kept on the local server." : "Add a key to start scanning.";
    get("key-indicator").textContent = state.hasKey ? "Key ready" : "API key required";
    get("key-indicator").dataset.key = state.hasKey ? "ready" : "missing";
    const running = state.job.status === "running";
    buttons("scan-button").disabled = running || !state.hasKey;
    buttons("estimate-button").disabled = running || !state.hasKey;
    buttons("resume-button").disabled = running || !state.hasKey;
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
    get("connection").textContent = "Local session";
    renderProgress(currentState);
    renderRecent();
    const signature = JSON.stringify(currentState.profiles);
    if (signature !== profileSignature) {
      profileSignature = signature; const value = profiles.value;
      profiles.replaceChildren(new Option("Choose a saved profile", ""), ...currentState.profiles.map((name) => new Option(name, name))); profiles.value = value;
    }
    const job = currentState.job;
    // Run IDs can be absent or reused. Deduplicate terminal results by operation identity.
    const terminal = `${job.operationId}:${job.status}`;
    if (job.status !== "running" && job.status !== "idle" && terminal !== lastJob) {
      lastJob = terminal;
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
  try { await api("/api/scan", Contracts.Ok, { target: inputs.target.value, settings: readSettings() }); }
  finally { await refresh(); }
}); });
buttons("estimate-button").addEventListener("click", () => task(async () => {
  buttons("estimate-button").disabled = true;
  try {
    const estimate = await api("/api/estimate", Contracts.Estimate, { target: inputs.target.value, settings: readSettings() });
    get("estimate-result").textContent = estimate.available ? `${estimate.directFriends} direct friends · approximately ${estimate.estimatedNodes} admitted nodes · ${estimate.sampleSize} public samples. ${estimate.note ?? ""}` : "The friend list is private or unavailable. No estimate is possible.";
  } finally { await refresh(); }
}));
preset.addEventListener("change", () => { if (preset.value === "inner" || preset.value === "community") applySettings(presets[preset.value]); });
get("scan-form").addEventListener("input", (event) => { if (event.target !== inputs.target) preset.value = "custom"; });
get("key-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  await api("/api/key", Contracts.Ok, { key: inputs.key.value }); inputs.key.value = ""; await refresh();
}); });
get("profile-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  await api("/api/profiles", Contracts.Ok, { name: inputs.name.value, settings: readSettings() }); await refresh();
}); });
buttons("load-profile").addEventListener("click", () => task(async () => {
  if (!profiles.value) throw new Error("Choose a saved profile first.");
  applySettings(await api(`/api/profiles/${encodeURIComponent(profiles.value)}`, Settings)); preset.value = "custom";
}));
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
edgeKind.addEventListener("change", renderGraph);
buttons("zoom-in").addEventListener("click", () => { zoom = Math.min(4, zoom * 1.25); renderGraph(); });
buttons("zoom-out").addEventListener("click", () => { zoom = Math.max(.5, zoom / 1.25); renderGraph(); });
buttons("zoom-reset").addEventListener("click", () => { zoom = 1; selectedNode = null; get("node-detail").textContent = "Select a node."; renderGraph(); });
get("history-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  const file = inputs.file.files?.[0];
  if (!file) throw new Error("Choose a normalized history file.");
  if (file.size > 2 * 1024 * 1024) throw new Error("The file exceeds the 2 MB import limit.");
  if (inputs.attach.checked && !selected) throw new Error("Open a matching run before attaching history.");
  const runId = inputs.attach.checked ? selected?.scan.id : undefined;
  const report = await api("/api/history", HistoryReport, { contents: await file.text(), runId });
  get("history-result").hidden = false; get("history-name").textContent = report.profile.name ?? report.profile.steamID64;
  get("history-warning").textContent = report.warning;
  const link = get("history-download"); link.hidden = !runId; if (runId) link.setAttribute("href", downloadLink(runId, "history.json").href);
  const rows = get("history-rows"); rows.replaceChildren();
  for (const friend of report.friends) {
    const row = document.createElement("tr"); playerCell(row, friend.id, friend.name);
    cell(row, `${Math.floor(friend.durationSeconds / 86400)} days`); cell(row, `${friend.relativeDuration.toFixed(1)}%`); cell(row, friend.currentlyFriends ? "yes" : "no"); rows.append(row);
  }
}); });
window.addEventListener("focus", () => void refresh());
applySettings(defaults);
const initialNavigation = navigationVersion;
void refresh().then(() => { const id = location.hash.slice(1); if (id && !selected) task(() => openRun(id, initialNavigation)); });
