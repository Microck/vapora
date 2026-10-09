import { Effect, Schema } from "effect";
import { artifacts, defaults, Player, Ranking, Settings } from "../src/model.js";
import type { Availability, SteamId } from "../src/model.js";
import * as Contracts from "../src/contracts.js";
import { displaySupport } from "../src/scoring.js";
import * as HistoryUI from "./history-view.js";
import { HistoryState, coverageError } from "../src/history.js";
import { HistoryReport } from "../src/history.js";
import * as Network from "./network.js";
import * as Tooltips from "./tooltips.js";
import * as Details from "./details.js";

declare global {
  interface Window {
    vaporaDesktop?: {
      minimize: () => Promise<void>; maximize: () => Promise<void>; close: () => Promise<void>;
      openOutputs: (id: string | null) => Promise<void>;
      isMaximized: () => Promise<boolean>; onMaximized: (callback: (maximized: boolean) => void) => () => void;
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
let preview: Pick<Player, "id" | "name" | "avatar"> | null = null;
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
const Screen = Schema.Literals(["scan", "results", "history"]);
let navigationVersion = 0;
let graphReport: Contracts.Report | null = null;
let graphSelection = "";

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
  if (name === "results") renderGraph();
}

/** Keep the selected VGUI tab against its panel, even when the strip overflows. */
function installTabStrips() {
  for (const tabs of document.querySelectorAll<HTMLElement>(".tabs")) {
    const bar = document.createElement("div"); bar.className = "tab-bar";
    const previous = document.createElement("button"); const next = document.createElement("button");
    const name = tabs.getAttribute("aria-label") ?? "Views";
    for (const [button, label, glyph] of [[previous, "Previous", "‹"], [next, "Next", "›"]] as const) {
      button.type = "button"; button.className = "tab-scroll"; button.textContent = glyph;
      button.setAttribute("aria-label", `${label} ${name.toLowerCase()}`);
    }
    tabs.before(bar); bar.append(previous, tabs, next);
    const revealSelected = () => {
      const selected = tabs.querySelector('[aria-current="page"]')?.getBoundingClientRect();
      if (!selected) return;
      const bounds = tabs.getBoundingClientRect();
      if (selected.left < bounds.left) tabs.scrollBy({ left: selected.left - bounds.left, behavior: "instant" });
      else if (selected.right > bounds.right) tabs.scrollBy({ left: selected.right - bounds.right, behavior: "instant" });
    };
    const update = () => {
      const overflow = tabs.scrollWidth > bar.clientWidth + 1;
      previous.hidden = next.hidden = !overflow;
      previous.disabled = tabs.scrollLeft <= 1;
      next.disabled = tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 1;
    };
    previous.addEventListener("click", () => tabs.scrollBy({ left: -tabs.clientWidth * .75, behavior: "instant" }));
    next.addEventListener("click", () => tabs.scrollBy({ left: tabs.clientWidth * .75, behavior: "instant" }));
    tabs.addEventListener("scroll", update);
    tabs.addEventListener("click", revealSelected);
    new ResizeObserver(() => { update(); revealSelected(); }).observe(bar);
    new MutationObserver(update).observe(tabs, { attributes: true, attributeFilter: ["hidden"], subtree: true });
    update();
  }
}

function notice(message: string) { get("notice").textContent = message; get("notice").hidden = !message; }
function task(action: () => Promise<void>, reportError: (message: string) => void = notice) {
  reportError("");
  void action().catch((error) => reportError(error instanceof Error ? error.message : "The action failed. Try again."));
}
function dialogTask(id: string, action: () => Promise<void>) {
  notice("");
  const status = get(`${id}-error`);
  task(action, (message) => {
    status.textContent = message; status.hidden = !message;
    if (message) status.focus({ preventScroll: true });
  });
}
async function api<T, P = never>(path: string, schema: Schema.ConstraintDecoder<T>, payload?: P) {
  const response = await fetch(path, payload === undefined ? { headers: { accept: "application/json" } } : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }).catch(() => { throw new Error("Cannot reach Vapora. Make sure the app is running, then retry the action."); });
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
  topN: control("topN").valueAsNumber, countBaseline: control("countBaseline").valueAsNumber,
  locationAggregation: select("locationAggregation").value, locationBaseline: control("locationBaseline").valueAsNumber,
  weights: { mutual: inputs.mutual.valueAsNumber, jaccard: inputs.jaccard.valueAsNumber, groups: inputs.groupWeight.valueAsNumber, games: inputs.gameWeight.valueAsNumber },
});
function applySettings(settings: Settings) {
  get("estimate-result").textContent = "";
  inputs.depth.value = String(settings.depth); inputs.nodes.value = String(settings.maxNodes); inputs.rpm.value = String(settings.requestsPerMinute);
  inputs.groups.checked = settings.includeGroups; inputs.games.checked = settings.includeGames; inputs.hub.value = String(settings.hubPercentile);
  inputs.skipPrivate.checked = settings.skipPrivate;
  inputs.mutual.value = String(settings.weights.mutual); inputs.jaccard.value = String(settings.weights.jaccard);
  inputs.groupWeight.value = String(settings.weights.groups); inputs.gameWeight.value = String(settings.weights.games);
  for (const name of ["topN", "countBaseline", "locationBaseline"] as const) control(name).value = String(settings[name]);
  select("locationAggregation").value = settings.locationAggregation;
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
  // An explicit lookup is fresher than the selected checkpoint, which may lack summaries after a failed scan.
  const player = preview && (target === previewTarget || target === preview.id) ? preview : matches ? selected?.scan.players.find((player) => player.id === seed) : undefined;
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
  link.dataset.tooltip = `Steam ID ${id}`; link.setAttribute("aria-label", `${name}, Steam ID ${id}`); td.append(link);
  return td;
}
const availabilityLabels = {
  public: "Public", private: "Private", pending: "Not scanned", unavailable: "Unavailable", disabled: "Off", skipped: "Skipped",
} satisfies Record<Availability, string>;
const observation = (value: number | null, statuses: readonly Availability[], digits = 0) => value !== null
  ? value.toFixed(digits) : availabilityLabels[statuses.find((status) => status !== "public") ?? "unavailable"];
const playerStatus = (player: Player | undefined, field: "groupsStatus" | "gamesStatus") => player?.[field] ?? "unavailable";
const profileOpeners = new Map<SteamId, HTMLButtonElement>();
const locationOpeners = new Map<string, HTMLButtonElement>();
function renderFriends() {
  const rows = get("friend-rows"); rows.replaceChildren(); profileOpeners.clear();
  const query = inputs.search.value.toLowerCase().trim();
  const friends = selected?.report.friends.filter((friend) => friend.name.toLowerCase().includes(query) || friend.id.includes(query)) ?? [];
  const players = new Map(selected?.scan.players.map((player) => [player.id, player]));
  const seed = selected ? players.get(selected.scan.seed) : undefined;
  for (const friend of friends) {
    const row = document.createElement("tr"); const profile = playerCell(row, friend.id, friend.name, players.get(friend.id)?.avatar ?? null);
    const inspect = document.createElement("button"); inspect.type = "button"; inspect.className = "inspect-button"; inspect.textContent = "Details";
    profileOpeners.set(friend.id, inspect);
    inspect.setAttribute("aria-label", `Details for ${friend.name}`); inspect.addEventListener("click", () => inspectNode(friend.id, () => profileOpeners.get(friend.id) ?? null)); profile.append(inspect);
    const player = players.get(friend.id);
    cell(row, friend.evidenceScore === null ? "Off" : friend.evidenceScore.toFixed(1)); cell(row, friend.incomingMutual);
    cell(row, observation(friend.jaccard, [seed?.friendsStatus ?? "unavailable", friend.friendsStatus], 3));
    cell(row, observation(friend.sharedGroups, [playerStatus(seed, "groupsStatus"), playerStatus(player, "groupsStatus")]));
    cell(row, observation(friend.sharedGames, [playerStatus(seed, "gamesStatus"), playerStatus(player, "gamesStatus")]));
    cell(row, friend.admitted ? availabilityLabels[friend.friendsStatus] : "Outside graph"); cell(row, player?.bans?.vacCount ?? "Unknown"); rows.append(row);
  }
  get("friend-empty").hidden = friends.length > 0;
}
function renderLocations() {
  const rows = get("location-rows"); rows.replaceChildren(); locationOpeners.clear();
  for (const location of selected?.report.locations ?? []) {
    const row = document.createElement("tr");
    for (const value of [location.country, location.state ?? "Not provided", location.city ?? "Not provided", location.contributors, displaySupport(location.support), location.share === null ? "Unknown" : location.share.toFixed(1), location.index === null ? "Unknown" : location.index.toFixed(1)]) cell(row, value);
    const details = document.createElement("button"); details.type = "button"; details.textContent = "Details";
    const identity = JSON.stringify([location.country, location.state, location.city]); locationOpeners.set(identity, details);
    details.addEventListener("click", () => Details.record(`Location ${location.country}`, { source: "Steam incoming mutual counts", ...location, coverage: selected?.report.locationCoverage }, () => locationOpeners.get(identity) ?? null));
    cell(row, "").append(details); rows.append(row);
  }
  const coverage = selected?.report.locationCoverage;
  get("location-coverage").textContent = coverage ? `${coverage.located}/${coverage.referenceSize} friends supply country and city` : "";
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
  if (scan) heading.dataset.tooltip = `${scan.players.find((p) => p.id === scan.seed)?.name ?? scan.seed} · ${new Date(scan.createdAt).toLocaleString()}`;
  tree.append(heading);
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
  profile.dataset.tooltip = `Steam ID ${scan.seed}`;
  get("report-status").textContent = scan.status;
  get("report-details").textContent = `${new Date(scan.createdAt).toLocaleString()} · Steam ID ${scan.seed} · depth ${scan.settings.depth} · ${scan.settings.maxNodes === 0 ? "no node cap" : `cap ${scan.settings.maxNodes}`}`;
  buttons("resume-button").hidden = scan.status === "complete" || (currentState?.job.status === "running" && currentState.job.id === scan.id);
  const coverage = get("coverage"); coverage.replaceChildren();
  for (const [label, value] of [["Profiles", report.coverage.nodes], ["Friendships", report.edges.filter((e) => e.kind === "friend").length], ["Public lists", report.coverage.publicLists], ["Direct friends", `${report.coverage.admittedDirectFriends}/${report.coverage.directFriends}`], ["Private lists", report.coverage.privateLists], ["Unavailable lists", report.coverage.unavailableLists]] as const) {
    const group = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd");
    term.textContent = label; detail.textContent = String(value); group.append(term, detail); coverage.append(group);
  }
  renderCoverageNotice(); renderRanking();
  const warnings = get("warnings"); warnings.replaceChildren();
  get("report-error").textContent = scan.error; get("report-error").hidden = !scan.error;
  for (const warning of report.warnings) { const p = document.createElement("p"); p.textContent = warning; warnings.append(p); }
  const exports = get("downloads"); exports.replaceChildren();
  for (const file of selected.history ? artifacts : downloads) if (scan.status === "complete" || file === "scan.json" || file === "run.log" || file === "history.json") exports.append(downloadLink(scan.id, file));
  const obsidian = document.createElement("a"); obsidian.id = "obsidian-export";
  obsidian.textContent = "↓ Obsidian vault (.zip)";
  obsidian.href = `/api/obsidian?${new URLSearchParams({ id: scan.id })}`; exports.append(obsidian);
  renderFriends(); renderLocations(); renderGraph(); renderTarget(); renderOutput();
}
function renderCoverageNotice() {
  if (!selected) return;
  const { scan, report } = selected;
  const coverage = report.coverage;
  const reasons = scan.truncated ? ["node cap reached"] : [];
  for (const [count, label] of [[coverage.privateLists, "private list"], [coverage.unavailableLists, "unavailable list"],
    [coverage.skippedLists, "skipped profile"], [coverage.pendingLists, "unscanned list"]] as const) {
    if (count) reasons.push(`${count} ${label}${count === 1 ? "" : "s"}`);
  }
  const partial = scan.status !== "complete" || reasons.length > 0;
  const warning = get("coverage-warning"); warning.hidden = !partial;
  warning.textContent = ["Partial results", ...reasons].join(" · ");
  get("open-history").hidden = !selected.history;
}
function renderRanking() {
  if (!selected) return;
  const { scan } = selected;
  const ranking = scan.settings;
  for (const name of ["topN", "countBaseline", "locationBaseline"] as const) control(`ranking-${name}`).value = String(ranking[name]);
  select("ranking-locationAggregation").value = ranking.locationAggregation;
  control("ranking-hub").value = String(ranking.hubPercentile);
  for (const name of ["mutual", "jaccard", "groups", "games"] as const) control(`ranking-${name}`).value = String(ranking.weights[name]);
  buttons("save-ranking").disabled = scan.status !== "complete" || currentState?.job.status === "running";
  buttons("rebuild-exports").disabled = buttons("save-ranking").disabled;
}
function inspectNode(id: SteamId, resolveOpener: Details.Opener) {
  selectedNode = id; renderGraph();
  openProfileDetails(id, resolveOpener);
}
function rankingFacts(id: SteamId): readonly (readonly [string, string | number])[] {
  const rank = selected?.report.friends.find((friend) => friend.id === id);
  return rank ? [
    ["Incoming mutuals", rank.incomingMutual], ["Undirected mutuals", rank.mutual],
    ["Count index / 100", rank.countIndex?.toFixed(2) ?? "Unknown"], ["Reference friends", selected?.report.coverage.directFriends ?? 0],
    ["Game Jaccard", rank.gameJaccard?.toFixed(4) ?? "Unknown"], ["Group Jaccard", rank.groupJaccard?.toFixed(4) ?? "Unknown"],
  ] : [];
}
function profileFacts(player: Player, metric: Contracts.Report["metrics"][number] | undefined): readonly (readonly [string, string | number])[] {
  const bans = player.bans;
  return [
    ["Friend list as of", player.friendsObservedAt ? new Date(player.friendsObservedAt).toLocaleString() : "Not observed"],
    ["Bans as of", player.bansObservedAt ? new Date(player.bansObservedAt).toLocaleString() : "Not observed"],
    ["Depth", player.level], ["Profile", availabilityLabels[player.visibility]], ["Friend list", availabilityLabels[player.friendsStatus]],
    ["Groups", player.groupsStatus === "public" ? player.groups.length : availabilityLabels[player.groupsStatus]],
    ["Games", player.gamesStatus === "public" ? player.games.length : availabilityLabels[player.gamesStatus]],
    ["VAC bans", bans ? bans.vacCount : availabilityLabels[player.bansStatus]],
    ["Game bans", bans ? bans.game : availabilityLabels[player.bansStatus]], ["Community ban", bans ? bans.community ? "Yes" : "No" : availabilityLabels[player.bansStatus]],
    ["Degree", metric?.degree ?? "unknown"], ["Betweenness", metric?.betweenness.toFixed(4) ?? "unknown"],
    ["Community", metric ? metric.community + 1 : "unknown"], ["Hub", metric ? metric.hub ? "Yes" : "No" : "unknown"],
  ];
}
function openProfileDetails(account: SteamId, resolveOpener: Details.Opener) {
  const player = selected?.scan.players.find((p) => p.id === account);
  const rank = selected?.report.friends.find((friend) => friend.id === account);
  const metric = selected?.report.metrics.find((m) => m.id === account);
  const id = player?.id ?? rank?.id;
  if (!id) return;
  const name = player?.name ?? rank?.name ?? id;
  const contents = document.createElement("div");
  const identity = document.createElement("div"); identity.className = "details-identity";
  const text = document.createElement("div"); const heading = document.createElement("h3"); heading.textContent = name;
  const link = document.createElement("a"); link.href = `https://steamcommunity.com/profiles/${id}/`;
  link.target = "_blank"; link.rel = "noreferrer"; link.textContent = id; link.dataset.tooltip = "Open Steam profile";
  text.append(heading, link); identity.append(avatarImage(player?.avatar ?? null), text);
  const facts = document.createElement("dl"); facts.className = "details-facts";
  const fields = player ? profileFacts(player, metric) : [["Collection", "Outside admitted graph"]] as const;
  for (const [label, value] of [...fields, ...rankingFacts(id)]) {
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = String(value); facts.append(term, detail);
  }
  contents.append(identity, facts); Details.open(`Details for ${name}`, contents, resolveOpener, id);
}
function renderGraph() {
  const graph = get("graph");
  if (!(graph instanceof SVGSVGElement) || !selected || get("network-view").hidden || get("results-screen").hidden || get("report").hidden) return;
  const selection = JSON.stringify([selectedNode, inputs.networkSearch.value, edgeKind.value]);
  if (graphReport === selected.report && graphSelection === selection) return;
  Network.render(graph, get("community-legend"), get("network-matches"), get("graph-count"), selected,
    { id: selectedNode, zoom, query: inputs.networkSearch.value, edges: edgeKind.value },
    (id) => inspectNode(id, () => graph.querySelector<SVGGElement>(`[data-node-id="${id}"]`)));
  graphReport = selected.report; graphSelection = selection;
}
function toggleRuns(visible: boolean) {
  get("run-library").hidden = !visible; buttons("toggle-runs").setAttribute("aria-expanded", String(visible));
  buttons("toggle-runs").textContent = visible && selected ? "Back to report" : "Saved runs";
  get("report").hidden = visible || !selected; get("empty").hidden = visible || Boolean(selected);
  if (!visible) renderGraph();
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
let accountHistory: HistoryState | null = null;
let historyRequest = 0;
let historyAccount: SteamId | null = null;
function renderHistory(report: HistoryReport, runId: string | null) {
  const matching = runId && selected?.scan.seed === report.profile.steamID64 ? selected.scan : undefined;
  HistoryUI.render(report, matching); historyAccount = report.profile.steamID64;
  const link = get("history-download"); link.hidden = !runId;
  if (runId) link.setAttribute("href", downloadLink(runId, "history.json").href);
}
function renderAccountHistory(state: HistoryState, runId?: string) {
  accountHistory = state; historyAccount = state.id;
  get("target-history-status").textContent = state.status === "partial" ? "History partial" : state.error ? "History unavailable" : "History ready";
  get("target-history-status").dataset.tooltip = state.error ?? "Saved history capture";
  get("target-history-retry").hidden = !state.error; get("history-retry").hidden = !state.error;
  get("history-fetch-status").textContent = state.error ?? ""; get("history-fetch-status").hidden = !state.error || state.status === "partial" && state.report !== null;
  if (state.report) {
    renderHistory(state.report, runId ?? null);
    if (runId && selected?.scan.id === runId) { selected = { ...selected, history: state.report }; renderReport(); }
  }
}
async function loadAccountHistory(id: SteamId, refresh = false, runId?: string) {
  const request = ++historyRequest;
  if (historyAccount !== id) { accountHistory = null; get("history-result").hidden = true; }
  historyAccount = id;
  get("history-fetch-status").hidden = true; get("history-retry").hidden = true;
  get("target-history-status").textContent = "Loading history";
  try {
    const state = await api("/api/history/account", HistoryState, { id, refresh, runId });
    if (request !== historyRequest) return;
    renderAccountHistory(state, runId);
  } catch (error) {
    if (request !== historyRequest) return;
    get("target-history-status").textContent = "History unavailable"; get("target-history-retry").hidden = false; get("history-retry").hidden = false;
    const message = error instanceof Error ? error.message : "History could not be loaded.";
    get("target-history-status").dataset.tooltip = message; get("history-fetch-status").textContent = message; get("history-fetch-status").hidden = false;
  }
}
async function openRun(id: string, navigation = navigationVersion) {
  const request = ++runRequest;
  const view = await api(`/api/runs/${encodeURIComponent(id)}`, Contracts.RunView);
  if (request !== runRequest) return;
  selected = view;
  const typed = inputs.target.value.trim();
  if (!typed || typed === linkedTarget) { inputs.target.value = selected.scan.seed; linkedTarget = selected.scan.seed; }
  selectedNode = null; zoom = 1; inputs.networkSearch.value = ""; toggleRuns(false);
  location.hash = id; renderReport(); renderRecent();
  if (view.historyError) notice(view.historyError);
  if (view.scan.status === "complete") void loadAccountHistory(view.scan.seed, false, view.scan.id);
  // A report response must not override a navigation choice made while it loaded.
  if (navigation === navigationVersion) {
    showScreen("results");
    get("results").focus({ preventScroll: true });
  }
}
function preselectTarget(run: typeof Contracts.RunSummary.Type) {
  // Selecting a target must also invalidate a saved-report response still in flight.
  runRequest++;
  inputs.target.value = run.seed;
  preview = { id: run.seed, name: run.name, avatar: run.avatar }; previewTarget = run.seed;
  get("estimate-result").replaceChildren();
  showScreen("scan"); renderTarget(); renderRecent();
  void loadAccountHistory(run.seed);
}
function renderRecent() {
  const signature = JSON.stringify([currentState?.runs, currentState?.runIssues, inputs.target.value.trim()]);
  if (signature === recentSignature) return;
  recentSignature = signature; const recent = get("recent"); recent.replaceChildren();
  const runs = currentState?.runs ?? [];
  const issues = currentState?.runIssues ?? [];
  for (const run of runs) {
    const button = document.createElement("button"); button.type = "button";
    button.append(avatarImage(run.avatar));
    button.setAttribute("aria-pressed", String(inputs.target.value.trim() === run.seed));
    button.dataset.tooltip = `Select ${run.name} as target`;
    button.setAttribute("aria-label", button.dataset.tooltip);
    button.addEventListener("click", () => preselectTarget(run)); recent.append(button);
  }
  for (const issue of issues) {
    const button = document.createElement("button"); button.type = "button"; button.append(avatarImage(null));
    button.dataset.tooltip = `Invalid run ${issue.id}`; button.setAttribute("aria-label", button.dataset.tooltip);
    button.addEventListener("click", () => notice(issue.message)); recent.append(button);
  }
  const emptySlots = Math.max(0, 5 - runs.length - issues.length);
  for (let i = 0; i < emptySlots; i++) {
    const empty = avatarImage(null); empty.setAttribute("aria-hidden", "true"); recent.append(empty);
  }
  if (runs.length + issues.length === 0) {
    const status = document.createElement("span"); status.className = "sr-only"; status.textContent = "No saved runs."; recent.append(status);
  }
}
function renderProgress(state: Contracts.State) {
    get("key-indicator").textContent = state.hasKey ? "Key ready" : "Key needed";
    get("key-indicator").dataset.key = state.hasKey ? "ready" : "missing";
    get("key-label").hidden = state.hasKey;
    const running = state.job.status === "running";
    buttons("scan-button").disabled = running;
    buttons("estimate-button").disabled = running;
    buttons("resume-button").disabled = running;
    buttons("lookup-target").disabled = running;
    buttons("open-key").disabled = running;
    buttons("save-ranking").disabled = running || selected?.scan.status !== "complete";
    buttons("rebuild-exports").disabled = running || selected?.scan.status !== "complete";
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
    get("key-indicator").textContent = "Disconnected";
    // A background poll must not replace the explanation of an unsaved action.
    if (get("notice").hidden) notice(error instanceof Error ? error.message : "Cannot reach Vapora. Make sure the app is running, then retry.");
  } finally {
    refreshing = false; clearTimeout(timer); timer = setTimeout(() => void refresh(), currentState?.job.status === "running" ? 1500 : 10000);
  }
}

let pendingKeyAction: (() => Promise<void>) | null = null;
function openKey(action: (() => Promise<void>) | null = null) {
  pendingKeyAction = action;
  get("key-error").hidden = true; get("key-status").textContent = "";
  const storage = currentState?.keyStorage;
  get("remember-key-label").hidden = !storage;
  control("remember-key").disabled = !storage?.available;
  control("remember-key").checked = Boolean(storage?.available && storage.remembered);
  buttons("forget-key").hidden = !storage?.remembered;
  get("key-session-note").textContent = storage
    ? storage.available ? "Session only unless remembered." : "Secure storage unavailable. Session only."
    : "Used for this session.";
  dialog("key-dialog").showModal();
}
function keyTask(action: () => Promise<void>) {
  get("key-error").hidden = true;
  for (const id of ["use-key", "cancel-key", "forget-key", "show-key"]) buttons(id).disabled = true;
  inputs.key.readOnly = true; control("remember-key").disabled = true;
  void action().catch((error) => {
    get("key-error").textContent = error instanceof Error ? error.message : "The key could not be updated. Try again.";
    get("key-error").hidden = false;
  }).finally(() => {
    for (const id of ["use-key", "cancel-key", "forget-key", "show-key"]) buttons(id).disabled = false;
    inputs.key.readOnly = false; control("remember-key").disabled = !currentState?.keyStorage?.available;
    get("key-status").textContent = "";
  });
}
buttons("forget-key").addEventListener("click", () => keyTask(async () => {
  get("key-status").textContent = "Removing saved key…";
  await api("/api/key/forget", Contracts.Ok, {}); await refresh();
  control("remember-key").checked = false; buttons("forget-key").hidden = true;
}));
function steamTask(action: () => Promise<void>) {
  if (!currentState?.hasKey) openKey(action);
  else task(action);
}
buttons("open-key").addEventListener("click", () => openKey());
get("scan-form").addEventListener("submit", (event) => { event.preventDefault(); steamTask(async () => {
  buttons("scan-button").disabled = true;
  const target = inputs.target.value;
  try { await api("/api/scan", Contracts.Ok, { target, settings: readSettings() }); linkedTarget = target.trim(); }
  finally { await refresh(); }
}); });
buttons("estimate-button").addEventListener("click", () => { if (!inputs.target.reportValidity()) return; steamTask(async () => {
  buttons("estimate-button").disabled = true;
  const target = inputs.target.value.trim(); const version = settingsVersion;
  try {
    const estimate = await api("/api/estimate", Contracts.Estimate, { target, settings: readSettings() });
    if (inputs.target.value.trim() === target && settingsVersion === version) renderEstimate(estimate);
  } finally { await refresh(); }
}); });
function renderEstimate(estimate: typeof Contracts.Estimate.Type) {
  const result = get("estimate-result"); result.replaceChildren();
  if (!estimate.available) { result.textContent = estimate.note ?? "The friend list is private or unavailable. No estimate is possible."; return; }
  const heading = document.createElement("div"); heading.className = "estimate-heading";
  const title = document.createElement("span"); title.textContent = "Sampling estimate";
  const help = document.createElement("button"); help.type = "button"; help.className = "info"; help.textContent = "i";
  help.setAttribute("aria-label", "About this estimate"); help.dataset.tooltip = estimate.note ?? "Sampling estimate; private lists and overlapping friends affect coverage.";
  heading.append(title, help);
  const facts = document.createElement("dl"); facts.className = "estimate-facts";
  for (const [label, value] of [["Direct friends", estimate.directFriends], ["Profiles", `≈ ${estimate.estimatedNodes?.toLocaleString()}`], ["Public samples", estimate.sampleSize]] as const) {
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = String(value); facts.append(term, detail);
  }
  result.append(heading, facts);
}
get("output-mode").addEventListener("change", (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  outputMode = Schema.decodeUnknownSync(OutputMode)(event.target.value); renderOutput();
});
for (const form of ["scan-form", "scan-ranking-form"]) get(form).addEventListener("input", () => { settingsVersion++; get("estimate-result").textContent = ""; });
inputs.target.addEventListener("input", () => { preview = null; previewTarget = ""; historyRequest++; accountHistory = null; historyAccount = null; get("target-history-status").textContent = ""; get("target-history-retry").hidden = true; get("history-result").hidden = true; get("history-fetch-status").hidden = true; get("estimate-result").textContent = ""; renderTarget(); renderRecent(); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-depth]")) button.addEventListener("click", () => {
  settingsVersion++; inputs.depth.value = button.dataset.depth ?? "2"; renderDepth(); get("estimate-result").textContent = "";
});
buttons("lookup-target").addEventListener("click", () => { if (!inputs.target.reportValidity()) return; steamTask(async () => {
  const target = inputs.target.value.trim(); buttons("lookup-target").disabled = true;
  try {
    const player = await api("/api/target", Player, { target, settings: readSettings() });
    if (inputs.target.value.trim() === target) { preview = player; previewTarget = target; renderTarget(); void loadAccountHistory(player.id); }
  } finally { await refresh(); }
}); });
buttons("apply-settings").addEventListener("click", () => task(async () => {
  if (!get("scan-form").querySelector<HTMLInputElement>(":invalid")) {
    await api("/api/profiles", Contracts.Ok, { name: "default", settings: readSettings() }); await refresh(); notice("Saved default settings.");
  } else throw new Error("Check the node limit and request rate.");
}, (message) => notice(message ? `Settings were not saved. ${message}` : "")));
buttons("show-key").addEventListener("click", () => {
  const show = inputs.key.type === "password";
  inputs.key.type = show ? "text" : "password";
  buttons("show-key").textContent = show ? "Hide" : "Show";
  buttons("show-key").setAttribute("aria-label", show ? "Hide API key" : "Show API key");
  buttons("show-key").setAttribute("aria-pressed", String(show));
});
dialog("key-dialog").addEventListener("close", () => {
  inputs.key.value = ""; inputs.key.type = "password"; pendingKeyAction = null;
  buttons("show-key").textContent = "Show"; buttons("show-key").setAttribute("aria-label", "Show API key");
  buttons("show-key").setAttribute("aria-pressed", "false");
});
dialog("key-dialog").addEventListener("cancel", (event) => {
  if (buttons("use-key").disabled) event.preventDefault();
});
get("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  keyTask(async () => {
    const key = inputs.key.value.trim();
    const remember = control("remember-key").checked;
    if (!/^[a-fA-F0-9]{32}$/.test(key)) throw new Error("Enter the 32-character key from Steam's API key page.");
    get("key-status").textContent = "Checking key with Steam…";
    await api("/api/key", Contracts.Ok, { key, remember });
    inputs.key.value = ""; await refresh();
    const continuation = pendingKeyAction;
    dialog("key-dialog").close();
    if (continuation) task(continuation);
  });
});
get("profile-form").addEventListener("submit", (event) => { event.preventDefault(); dialogTask("save-dialog", async () => {
  inputs.name.setAttribute("aria-invalid", String(!inputs.name.checkValidity()));
  if (!inputs.name.validity.valid) throw new Error("Use 1-64 letters, digits, hyphens or underscores. Start with a letter or digit.");
  await api("/api/profiles", Contracts.Ok, { name: inputs.name.value, settings: readSettings() }); dialog("save-dialog").close(); await refresh();
}); });
buttons("load-profile").addEventListener("click", () => dialogTask("load-dialog", async () => {
  profiles.setAttribute("aria-invalid", String(!profiles.value));
  if (!profiles.value) throw new Error("Choose a saved profile, then click Load.");
  applySettings(await api(`/api/profiles/${encodeURIComponent(profiles.value)}`, Settings)); dialog("load-dialog").close();
}));
inputs.name.addEventListener("input", () => inputs.name.removeAttribute("aria-invalid"));
profiles.addEventListener("change", () => profiles.removeAttribute("aria-invalid"));
for (const id of ["save-dialog", "load-dialog", "history-import-dialog"]) dialog(id).addEventListener("close", () => {
  get(`${id}-error`).hidden = true; get(`${id}-error`).textContent = "";
});
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
  const showMaximized = (maximized: boolean) => {
    buttons("window-maximize").dataset.maximized = String(maximized);
    buttons("window-maximize").setAttribute("aria-label", maximized ? "Restore" : "Maximize");
  };
  desktop.onMaximized(showMaximized);
  task(async () => showMaximized(await desktop.isMaximized()));
}
buttons("output-folder").addEventListener("click", () => {
  if (desktop) task(() => desktop.openOutputs(selected?.scan.id ?? null));
  else {
    if (!selected) { notice("Open a saved run to see its exports."); return; }
    showScreen("results");
    toggleRuns(false);
    document.querySelector<HTMLButtonElement>('[data-view="exports"]')?.click();
  }
});
buttons("save-settings").addEventListener("click", () => dialog("save-dialog").showModal());
buttons("open-settings").addEventListener("click", () => dialog("load-dialog").showModal());
buttons("open-scan-ranking").addEventListener("click", () => dialog("scan-ranking-dialog").showModal());
get("scan-ranking-form").addEventListener("submit", (event) => { event.preventDefault(); dialog("scan-ranking-dialog").close(); });
buttons("open-run-info").addEventListener("click", () => dialog("run-info-dialog").showModal());
for (const button of document.querySelectorAll<HTMLElement>("[data-close]")) button.addEventListener("click", () => dialog(button.dataset.close ?? "").close());
buttons("cancel-button").addEventListener("click", () => task(async () => { await api("/api/cancel", Contracts.Ok, {}); await refresh(); }));
buttons("resume-button").addEventListener("click", () => steamTask(async () => { if (selected) { await api("/api/resume", Contracts.Ok, { id: selected.scan.id }); await refresh(); } }));
inputs.search.addEventListener("input", renderFriends);
for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-screen]")) {
  const screen = Schema.decodeUnknownSync(Screen)(tab.dataset.screen);
  tab.addEventListener("click", () => showScreen(screen));
}
for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-view]")) tab.addEventListener("click", () => {
  for (const other of document.querySelectorAll("[data-view]")) other.removeAttribute("aria-current");
  tab.setAttribute("aria-current", "page");
  for (const view of document.querySelectorAll<HTMLElement>(".view")) view.hidden = view.id !== `${tab.dataset.view}-view`;
  if (tab.dataset.view === "network") renderGraph();
});
buttons("rebuild-exports").addEventListener("click", () => task(async () => {
  if (!selected) return;
  const id = selected.scan.id; buttons("rebuild-exports").disabled = true;
  try {
    const view = await api("/api/rebuild", Contracts.RunView, { id });
    if (selected?.scan.id === id) { selected = view; renderReport(); }
    notice("Rebuilt exports from saved observations.");
  } finally { await refresh(); }
}));
inputs.runSearch.addEventListener("input", renderRuns); select("run-status").addEventListener("change", renderRuns);
inputs.networkSearch.addEventListener("input", renderGraph);
buttons("toggle-runs").addEventListener("click", () => toggleRuns(get("run-library").hidden));
buttons("open-history").addEventListener("click", () => {
  if (selected?.history) { renderHistory(selected.history, selected.scan.id); showScreen("history"); }
});
get("ranking-form").addEventListener("submit", (event) => { event.preventDefault(); task(async () => {
  if (!selected) return;
  const id = selected.scan.id;
  const ranking = Schema.decodeUnknownSync(Ranking)({ topN: control("ranking-topN").valueAsNumber, countBaseline: control("ranking-countBaseline").valueAsNumber, locationBaseline: control("ranking-locationBaseline").valueAsNumber, locationAggregation: select("ranking-locationAggregation").value, hubPercentile: control("ranking-hub").valueAsNumber,
    weights: { mutual: control("ranking-mutual").valueAsNumber, jaccard: control("ranking-jaccard").valueAsNumber, groups: control("ranking-groups").valueAsNumber, games: control("ranking-games").valueAsNumber } });
  buttons("save-ranking").disabled = true;
  try {
    const view = await api("/api/analyze", Contracts.RunView, { id, ranking });
    if (selected?.scan.id === id) { selected = view; renderReport(); }
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
buttons("zoom-reset").addEventListener("click", () => { zoom = 1; selectedNode = null; renderGraph(); renderZoom(); });
get("history-form").addEventListener("submit", (event) => { event.preventDefault(); dialogTask("history-import-dialog", async () => {
  const file = inputs.file.files?.[0];
  if (!file) throw new Error("Choose a normalized history file.");
  if (file.size > 2 * 1024 * 1024) throw new Error("The file exceeds the 2 MB import limit.");
  if (inputs.attach.checked && !selected) throw new Error("Open a matching run before attaching history.");
  const runId = inputs.attach.checked ? selected?.scan.id : undefined;
  const report = await api("/api/history", HistoryReport, { contents: new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(await file.arrayBuffer()), runId });
  // An import supersedes any automatic history response still in flight.
  historyRequest++;
  const error = coverageError(report);
  renderAccountHistory({ id: report.profile.steamID64, status: error ? "partial" : "ready", error, report }, runId);
  dialog("history-import-dialog").close();

}); });
window.addEventListener("focus", () => void refresh());
buttons("open-history-import").addEventListener("click", () => dialog("history-import-dialog").showModal());
buttons("target-history").addEventListener("click", () => {
  if (accountHistory?.report) renderHistory(accountHistory.report, null);
  showScreen("history");
});
function refreshAccountHistory(id: SteamId | null) {
  if (id) void loadAccountHistory(id, true, selected?.scan.seed === id ? selected.scan.id : undefined);
}
buttons("target-history-retry").addEventListener("click", () => refreshAccountHistory(preview?.id ?? historyAccount));
for (const id of ["history-refresh", "history-retry"]) buttons(id).addEventListener("click", () => refreshAccountHistory(historyAccount));
HistoryUI.initialize();
installTabStrips();
applySettings(defaults);
Tooltips.install(get("app-tooltip"));
renderTarget(); renderOutput(); renderRecent();
const initialNavigation = navigationVersion;
void refresh().then(() => { const id = location.hash.slice(1); if (id && !selected) task(() => openRun(id, initialNavigation)); });
