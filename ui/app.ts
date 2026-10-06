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
const profiles = select("profiles"); const edgeKind = select("edge-kind");
const Preset = Schema.Literals(["community", "inner", "custom"]);
const presetRadios = [...get("preset").querySelectorAll<HTMLInputElement>('input[name="preset"]')];
function setPreset(value: typeof Preset.Type) {
  for (const radio of presetRadios) radio.checked = radio.value === value;
}
let selected: Contracts.RunView | null = null;
// Only replace a target with its resolved seed while the submitted text is still unchanged.
let linkedTarget = "";
let currentState: Contracts.State | null = null;
let recentSignature = "";
let profileSignature = "";
let lastJob: string | null = null;
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
  get("estimate-result").textContent = "";
  inputs.depth.value = String(settings.depth); inputs.nodes.value = String(settings.maxNodes); inputs.rpm.value = String(settings.requestsPerMinute);
  inputs.groups.checked = settings.includeGroups; inputs.games.checked = settings.includeGames; inputs.hub.value = String(settings.hubPercentile);
  inputs.mutual.value = String(settings.weights.mutual); inputs.jaccard.value = String(settings.weights.jaccard);
  inputs.groupWeight.value = String(settings.weights.groups); inputs.gameWeight.value = String(settings.weights.games);
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
  const player = matches ? selected?.scan.players.find((player) => player.id === seed) : undefined;
  get("target-name").textContent = matches ? player?.name ?? seed : "";
  profileImage("target-avatar", player?.avatar ?? null);
  get("target-id").textContent = matches ? seed : "";
  get("target-name").hidden = !matches; get("target-id").hidden = !matches;
}
function cell(row: HTMLTableRowElement, text: string | number) {
  const td = document.createElement("td"); td.textContent = String(text); row.append(td); return td;
}
function playerCell(row: HTMLTableRowElement, id: SteamId, name: string, avatar: string | null) {
  const td = cell(row, ""); const link = document.createElement("a"); link.className = "player-link"; link.append(avatarImage(avatar), document.createTextNode(name));
  link.href = `https://steamcommunity.com/profiles/${id}/`; link.target = "_blank"; link.rel = "noreferrer";
  link.title = `Steam ID ${id}`; link.setAttribute("aria-label", `${name}, Steam ID ${id}`); td.append(link);
}
const number = (value: number | null, digits = 0) => value === null ? "unknown" : value.toFixed(digits);
function renderFriends() {
  const rows = get("friend-rows"); rows.replaceChildren();
  const query = inputs.search.value.toLowerCase().trim();
  const friends = selected?.report.friends.filter((friend) => friend.name.toLowerCase().includes(query) || friend.id.includes(query)) ?? [];
  const players = new Map(selected?.scan.players.map((player) => [player.id, player]));
  for (const friend of friends) {
    const row = document.createElement("tr"); playerCell(row, friend.id, friend.name, players.get(friend.id)?.avatar ?? null);
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
  const target = scan.players.find((player) => player.id === scan.seed);
  get("report-name").textContent = target?.name ?? scan.seed;
  profileImage("report-avatar", target?.avatar ?? null);
  const profile = get("report-profile"); profile.setAttribute("href", `https://steamcommunity.com/profiles/${scan.seed}/`); profile.textContent = "Steam profile ↗";
  profile.title = `Steam ID ${scan.seed}`;
  get("report-status").textContent = scan.status;
  get("report-details").textContent = `${new Date(scan.createdAt).toLocaleString()} · Steam ID ${scan.seed} · depth ${scan.settings.depth} · cap ${scan.settings.maxNodes}`;
  buttons("resume-button").hidden = scan.status === "complete" || (currentState?.job.status === "running" && currentState.job.id === scan.id);
  const coverage = get("coverage"); coverage.replaceChildren();
  for (const [label, value] of [["Profiles", report.coverage.nodes], ["Friendships", report.edges.filter((e) => e.kind === "friend").length], ["Public friend lists", report.coverage.publicLists], ["Direct friends included", `${report.coverage.admittedDirectFriends}/${report.coverage.directFriends}`]] as const) {
    const group = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd");
    term.textContent = label; detail.textContent = String(value); group.append(term, detail); coverage.append(group);
  }
  const warnings = get("warnings"); warnings.replaceChildren();
  get("report-error").textContent = scan.error; get("report-error").hidden = !scan.error;
  for (const warning of report.warnings) { const p = document.createElement("p"); p.textContent = warning; warnings.append(p); }
  const exports = get("downloads"); exports.replaceChildren();
  for (const file of downloads) if (scan.status === "complete" || file === "scan.json" || file === "run.log") exports.append(downloadLink(scan.id, file));
  renderFriends(); renderLocations(); renderGraph(); renderTarget();
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
    line.setAttribute("stroke", edge.kind === "friend" ? "#879b76" : "#aa9767"); graph.append(line);
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
  const typed = inputs.target.value.trim();
  if (!typed || typed === linkedTarget) { inputs.target.value = selected.scan.seed; linkedTarget = selected.scan.seed; }
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
    const button = document.createElement("button"); button.type = "button";
    const name = document.createElement("span"); name.className = "run-name"; name.textContent = run.name;
    button.append(avatarImage(run.avatar), name);
    button.setAttribute("aria-current", String(selected?.scan.id === run.id));
    button.title = `${run.status} · ${run.nodes} profiles · ${new Date(run.createdAt).toLocaleString()}`;
    button.setAttribute("aria-label", `${run.name}, ${button.title}`);
    const status = document.createElement("span"); status.className = "run-status"; status.textContent = run.status;
    button.append(status); button.addEventListener("click", () => task(() => openRun(run.id))); recent.append(button);
  }
  for (const issue of currentState?.runIssues ?? []) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = `Invalid run ${issue.id}`;
    button.addEventListener("click", () => notice(issue.message)); recent.append(button);
  }
  if (!currentState?.runs.length && !currentState?.runIssues.length) { const p = document.createElement("p"); p.textContent = "No saved runs yet."; p.className = "hint"; recent.append(p); }
}
function renderProgress(state: Contracts.State) {
    get("key-status").textContent = state.hasKey ? "Key set for this session." : "Key required.";
    get("key-indicator").textContent = state.hasKey ? "Key ready" : "Key needed";
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
    get("estimate-result").textContent = estimate.available ? `${estimate.directFriends} direct friends · approximately ${estimate.estimatedNodes} admitted nodes · ${estimate.sampleSize} public samples. ${estimate.note ?? ""}` : "The friend list is private or unavailable. No estimate is possible.";
  } finally { await refresh(); }
}));
get("preset").addEventListener("change", (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  const value = Schema.decodeUnknownSync(Preset)(event.target.value);
  if (value !== "custom") applySettings(presets[value]);
});
// Radio input fires before change. Only edits to settings select Custom.
get("scan-form").addEventListener("input", (event) => { get("estimate-result").textContent = ""; if (!presetRadios.some((radio) => radio === event.target)) setPreset("custom"); });
inputs.target.addEventListener("input", () => { get("estimate-result").textContent = ""; renderTarget(); });
get("key-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  await api("/api/key", Contracts.Ok, { key: inputs.key.value }); inputs.key.value = ""; await refresh();
}); });
get("profile-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  await api("/api/profiles", Contracts.Ok, { name: inputs.name.value, settings: readSettings() }); await refresh();
}); });
buttons("load-profile").addEventListener("click", () => task(async () => {
  if (!profiles.value) throw new Error("Choose a saved profile first.");
  applySettings(await api(`/api/profiles/${encodeURIComponent(profiles.value)}`, Settings)); setPreset("custom");
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
    const row = document.createElement("tr"); playerCell(row, friend.id, friend.name, null);
    cell(row, `${Math.floor(friend.durationSeconds / 86400)} days`); cell(row, `${friend.relativeDuration.toFixed(1)}%`); cell(row, friend.currentlyFriends ? "yes" : "no"); rows.append(row);
  }
}); });
window.addEventListener("focus", () => void refresh());
applySettings(defaults);
renderTarget();
const initialNavigation = navigationVersion;
void refresh().then(() => { const id = location.hash.slice(1); if (id && !selected) task(() => openRun(id, initialNavigation)); });
