import { displaySupport } from "../src/scoring.js";
import * as History from "../src/history.js";
import * as Details from "./details.js";
import type { Scan } from "../src/model.js";

const get = (id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing history element: ${id}`);
  return element;
};
const input = (id: string) => {
  const element = get(id); if (!(element instanceof HTMLInputElement)) throw new Error(`Expected history input: ${id}`); return element;
};
const choice = (id: string) => {
  const element = get(id); if (!(element instanceof HTMLSelectElement)) throw new Error(`Expected history select: ${id}`); return element;
};
let current: History.HistoryReport | null = null;
let scan: Scan | undefined;
let section = "friends";
let page = 0;
const pageSize = 100;
let analyzed: { report: History.HistoryReport; scan: Scan | undefined; from: string; to: string; view: History.HistoryReport } | undefined;
const recordOpeners = new Map<string, HTMLButtonElement>();
const date = (value: number | null) => value === null ? "Undated" : new Date(value * 1000).toLocaleDateString();
const fieldText = (value: History.Record[string] | undefined): string => value === undefined || value === null ? "Not supplied" : String(value);
const numeric = (value: number | null, digits = 1) => value === null ? "Unknown" : value.toFixed(digits);
const rowCell = (row: HTMLTableRowElement, value: string | number) => { const cell = document.createElement("td"); cell.textContent = String(value); row.append(cell); return cell; };
function details(record: History.Record | readonly History.Record[], resolveOpener: Details.Opener) {
  Details.record("Captured record", record, resolveOpener);
}
function inspect(row: HTMLTableRowElement, record: History.Record | readonly History.Record[], identity: string) {
  const button = document.createElement("button"); button.type = "button"; button.textContent = "Details";
  const key = JSON.stringify([current?.profile.steamID64, section, identity]); recordOpeners.set(key, button);
  button.addEventListener("click", () => details(record, () => recordOpeners.get(key) ?? null)); rowCell(row, "").append(button);
}
function identity(row: HTMLTableRowElement, id: string | null, name: string, image: string | null) {
  const cell = rowCell(row, "");
  const avatar = document.createElement("img"); avatar.width = 24; avatar.height = 24; avatar.className = "profile-avatar"; avatar.alt = "";
  avatar.src = image ?? "/placeholder.jpg"; avatar.referrerPolicy = "no-referrer";
  avatar.onerror = () => { avatar.onerror = null; avatar.src = "/placeholder.jpg"; };
  const link = document.createElement(id ? "a" : "span"); link.append(avatar, document.createTextNode(name)); link.className = "player-link";
  if (link instanceof HTMLAnchorElement) {
    link.href = `https://steamcommunity.com/profiles/${id}/`; link.target = "_blank"; link.rel = "noreferrer";
    link.setAttribute("aria-label", `${name}, Steam ID ${id}`); link.dataset.tooltip = `Steam ID ${id}`;
  }
  cell.append(link);
}
function filteredReport() {
  if (!current) return null;
  const from = input("history-from").value; const to = input("history-to").value;
  if (analyzed?.report === current && analyzed.scan === scan && analyzed.from === from && analyzed.to === to) return analyzed.view;
  const range: History.Filter = { from: from ? Date.parse(`${from}T00:00:00Z`) / 1000 : undefined, to: to ? Date.parse(`${to}T23:59:59Z`) / 1000 : undefined };
  const view = History.view(current, scan, range); analyzed = { report: current, scan, from, to, view }; return view;
}
const statusMatches = (status: string) => choice("history-status").value === "all" || choice("history-status").value === status;
function paginate<T>(records: readonly T[], renderRow: (record: T) => HTMLTableRowElement) {
  return { rows: records.slice(page * pageSize, (page + 1) * pageSize).map(renderRow), total: records.length };
}
function table(headers: readonly string[], { rows, total }: { rows: readonly HTMLTableRowElement[]; total: number }) {
  const heading = get("history-columns"); heading.replaceChildren();
  for (const label of headers) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = label; heading.append(cell); }
  get("history-rows").replaceChildren(...rows);
  get("history-count").textContent = total ? `${Math.min(total, page * pageSize + 1)}–${Math.min(total, (page + 1) * pageSize)} of ${total}` : "No matching records";
  const previous = get("history-previous"); const next = get("history-next");
  if (previous instanceof HTMLButtonElement) previous.disabled = page === 0;
  if (next instanceof HTMLButtonElement) next.disabled = (page + 1) * pageSize >= total;
}
function friendsRows(report: History.HistoryReport, query: string) {
  return paginate(report.friends.filter((friend) => JSON.stringify(friend.metadata).toLowerCase().includes(query) && statusMatches(friend.status)), (friend) => {
      const row = document.createElement("tr"); identity(row, friend.id, friend.name, friend.avatar);
      const days = friend.durationSeconds === null ? null : Math.floor(friend.durationSeconds / 86400);
      rowCell(row, friend.status); rowCell(row, date(friend.asOf)); rowCell(row, days === null ? "Unknown" : `${days} ${days === 1 ? "day" : "days"}`);
      rowCell(row, numeric(friend.relativeDuration)); inspect(row, friend.periodSources, friend.id); return row;
  });
}
function rankingRows(report: History.HistoryReport, query: string) {
  return paginate(report.commenters.filter((author) => `${author.name} ${author.id ?? ""}`.toLowerCase().includes(query) && statusMatches(author.status)), (author) => {
      const row = document.createElement("tr"); identity(row, author.id, author.name, author.avatar);
      rowCell(row, author.count); rowCell(row, date(author.latest)); rowCell(row, author.status); rowCell(row, `${numeric(author.share)}%`);
      rowCell(row, author.inReference ? numeric(author.index) : "Outside reference"); return row;
  });
}
function commentsRows(report: History.HistoryReport, query: string) {
  // Unidentified comments share no identity, even when ranking groups their counts.
  const authors = new Map(report.commenters.filter((author) => author.id !== null).map((author) => [author.id, author]));
  return paginate(report.comments.filter((comment) => `${authors.get(comment.author)?.name ?? ""} ${comment.author ?? ""} ${comment.message}`.toLowerCase().includes(query)), (comment) => {
      const author = authors.get(comment.author);
      const row = document.createElement("tr"); identity(row, comment.author, author?.name ?? comment.author ?? "Unknown author", author?.avatar ?? null);
      rowCell(row, date(comment.timestamp)); rowCell(row, comment.message); rowCell(row, comment.friendAtComment); rowCell(row, comment.estimated ? "Estimated" : "Identified"); inspect(row, comment.versions, comment.key); return row;
  });
}
function dateFilter() {
  const from = input("history-from").value; const to = input("history-to").value;
  const minimum = from ? Date.parse(`${from}T00:00:00Z`) / 1000 : 0; const maximum = to ? Date.parse(`${to}T23:59:59Z`) / 1000 : Infinity;
  return (stamp: number | null) => (!from && !to) || (stamp !== null && Number.isFinite(stamp) && stamp >= minimum && stamp <= maximum);
}
function profileRows(report: History.HistoryReport, query: string) {
  const dateMatches = dateFilter();
  const profiles = report.sources.flatMap((source, sourceIndex) => source.snapshots.map((profile, snapshotIndex) =>
    ({ profile, sourceIndex, snapshotIndex })));
  return paginate(profiles.filter(({ profile }) => JSON.stringify(profile.fields).toLowerCase().includes(query) && dateMatches(profile.lastChecked)), ({ profile, sourceIndex, snapshotIndex }) => {
    const row = document.createElement("tr"); const fields = profile.fields;
    rowCell(row, profile.name); rowCell(row, date(profile.lastChecked));
    const created = History.time(fields.creationDate);
    rowCell(row, created === null ? fields.creationDate == null ? "Not supplied" : "Unknown" : date(created));
    for (const key of ["vacBanned", "vacCount", "gameBans", "communityBanned", "economyBanned"]) {
      const value = fields[key];
      rowCell(row, value === true ? "Yes" : value === false ? "No" : value === "none" ? "None" : fieldText(value));
    }
    inspect(row, fields, JSON.stringify([sourceIndex, snapshotIndex])); return row;
  });
}
function recordRows(report: History.HistoryReport, query: string) {
  const dateMatches = dateFilter();
  const match = (record: History.Record) => JSON.stringify(record).toLowerCase().includes(query);
    // Retain the dated context of each supplied record; generic details expose all fields, including unknown ones.
    // Positions belong to the retained source, before filtering or pagination, so identical records keep distinct openers.
    const records = report.sources.flatMap((source, sourceIndex) => source.snapshots.flatMap((profile, snapshotIndex) => (profile.historic[section] ?? []).map((record, recordIndex) =>
      ({ record, observed: profile.lastChecked, event: History.time(record.Timestamp), sourceIndex, snapshotIndex, recordIndex }))));
    return paginate(records.filter(({ record, event }) => match(record) && dateMatches(event)), ({ record, observed, event, sourceIndex, snapshotIndex, recordIndex }) => {
      const row = document.createElement("tr");
      if (section === "pfp") identity(row, null, fieldText(record.AvatarHash), History.avatar(record));
      else rowCell(row, fieldText(record.Name ?? record.URL));
      rowCell(row, date(event)); rowCell(row, date(observed)); inspect(row, record, JSON.stringify([sourceIndex, snapshotIndex, recordIndex])); return row;
    });
}
function renderTable() {
  recordOpeners.clear();
  const report = filteredReport(); if (!report) return;
  const query = input("history-search").value.trim().toLowerCase();
  get("history-status-label").hidden = !["friends", "ranking"].includes(section);
  if (section === "friends") {
    table(["Friend", "Status", "As of", "Captured duration", "Relative / 100", "Records"], friendsRows(report, query));
  } else if (section === "ranking") {
    table(["Commenter", "Captured count", "Latest", "Friend status", "Share", "Friend index / 100"], rankingRows(report, query));
  } else if (section === "comments") {
    table(["Author", "Date", "Comment", "Captured friend at comment", "Identity", "Versions"], commentsRows(report, query));
  } else if (section === "locations") {
    const locations = paginate(report.locations.filter((location) => `${location.country}/${location.state}/${location.city}`.toLowerCase().includes(query)), (location) => {
      const row = document.createElement("tr");
      for (const value of [location.country, location.state ?? "Not supplied", location.city, location.contributors, location.zeroContributors, displaySupport(location.support), numeric(location.share), numeric(location.index)]) rowCell(row, value);
      inspect(row, { ...location, source: "Captured friend comments", coverage: report.locationCoverage }, JSON.stringify([location.country, location.state, location.city])); return row;
    });
    table(["Country", "State", "City", "Contributors", "Zero counts", "Raw support", "Share %", "Index / 100", "Details"], locations);
  } else if (section === "profile") {
    table(["Name", "Source as of", "Created", "VAC banned", "VAC count", "Game bans", "Community ban", "Economy ban", "All fields"], profileRows(report, query));
  } else {
    table([section === "pfp" ? "Avatar" : section === "url" ? "URL" : "Name", "Record date", "Source as of", "All fields"], recordRows(report, query));
  }
  get("history-scope").textContent = `${report.sources.length} capture${report.sources.length === 1 ? "" : "s"} · ${report.comments.length} estimated comments · ${report.referenceSize} friend commenters in reference`;
}
function download(contents: string, filename: string) {
  const blob = new Blob([contents], { type: "application/json" }); const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function render(report: History.HistoryReport, selectedScan?: Scan) {
  current = report; scan = selectedScan; page = 0;
  get("history-result").hidden = false; get("history-name").textContent = report.profile.name;
  get("history-asof").textContent = `History as of ${date(report.profile.lastChecked)}`;
  get("history-asof").dataset.tooltip = report.warning;
  const sources = get("history-sources"); sources.replaceChildren();
  report.sources.forEach((source, index) => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = `Original ${index + 1}`;
    button.dataset.tooltip = `Captured ${source.capturedAt}`;
    button.addEventListener("click", () => download(source.contents, `history-${report.profile.steamID64}-${index + 1}.json`)); sources.append(button);
  });
  get("history-warnings").textContent = report.warnings.join("\n"); get("history-warnings").hidden = !report.warnings.length;
  renderTable();
}
export function initialize() {
  for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-history]")) tab.addEventListener("click", () => {
    section = tab.dataset.history ?? "friends"; page = 0;
    for (const other of document.querySelectorAll("[data-history]")) other.removeAttribute("aria-current");
    tab.setAttribute("aria-current", "page"); renderTable();
  });
  for (const id of ["history-search", "history-from", "history-to"]) get(id).addEventListener("input", () => { page = 0; renderTable(); });
  get("history-status").addEventListener("change", () => { page = 0; renderTable(); });
  get("history-previous").addEventListener("click", () => { page--; renderTable(); });
  get("history-next").addEventListener("click", () => { page++; renderTable(); });
  get("history-export").addEventListener("click", () => { if (current) download(JSON.stringify(current, null, 2), "history.json"); });
}
