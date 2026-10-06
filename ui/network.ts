import type { SteamId } from "../src/model.js";
import type { RunView } from "../src/contracts.js";

const colors = ["#8abfff", "#a8dba8", "#e9b9e8", "#eed68b", "#99d9d9", "#e6ad95"];
const svgElement = <K extends keyof SVGElementTagNameMap>(tag: K) => document.createElementNS("http://www.w3.org/2000/svg", tag);
const color = (community: number) => colors[community % colors.length] ?? "#fff";

/** Stable community clusters keep the same positions across search, selection and zoom. */
function positions(view: RunView) {
  const groups = new Map<number, typeof view.report.metrics[number][]>();
  for (const metric of view.report.metrics) {
    const members = groups.get(metric.community) ?? []; members.push(metric); groups.set(metric.community, members);
  }
  const columns = Math.ceil(Math.sqrt(groups.size));
  const rows = Math.ceil(groups.size / columns);
  const cellWidth = 940 / Math.max(1, columns); const cellHeight = 590 / Math.max(1, rows);
  const points = new Map<SteamId, { x: number; y: number }>();
  let groupIndex = 0;
  for (const [, members] of [...groups].sort(([a], [b]) => a - b)) {
    const x = 30 + cellWidth * ((groupIndex % columns) + .5);
    const y = 30 + cellHeight * (Math.floor(groupIndex / columns) + .5);
    const sorted = [...members].sort((a, b) => Number(b.id === view.scan.seed) - Number(a.id === view.scan.seed) || a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i++) {
      const metric = sorted[i]; if (!metric) continue;
      const radius = Math.sqrt(i / Math.max(1, sorted.length - 1)) * .38;
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      points.set(metric.id, { x: x + Math.cos(angle) * radius * cellWidth, y: y + Math.sin(angle) * radius * cellHeight });
    }
    groupIndex++;
  }
  // Reports always contain the admitted seed, including incomplete runs.
  // Fit sparse and dense runs to their extent instead of leaving small runs in an empty canvas.
  const x = [...points.values()].map((point) => point.x); const y = [...points.values()].map((point) => point.y);
  const left = Math.min(...x) - 50; const top = Math.min(...y) - 50;
  const width = Math.max(...x) - left + 130; const height = Math.max(...y) - top + 50;
  return { groups, points, left, top, width, height };
}

// Each newly loaded or reranked report owns its layout; obsolete reports can be collected.
const layouts = new WeakMap<RunView["report"], ReturnType<typeof positions>>();
function layout(view: RunView) {
  let cached = layouts.get(view.report);
  if (!cached) { cached = positions(view); layouts.set(view.report, cached); }
  return cached;
}

export function setZoom(graph: SVGSVGElement, view: RunView, zoom: number) {
  const { left, top, width, height } = layout(view);
  graph.setAttribute("viewBox", `${left + width / 2 - width / (2 * zoom)} ${top + height / 2 - height / (2 * zoom)} ${width / zoom} ${height / zoom}`);
}

function renderLegend(container: HTMLElement, groups: ReadonlyMap<number, RunView["report"]["metrics"]>) {
  container.replaceChildren();
  for (const [community, members] of [...groups].sort(([a], [b]) => a - b)) {
    const entry = document.createElement("span"); const swatch = svgElement("svg"); const dot = svgElement("circle");
    swatch.setAttribute("width", "12"); swatch.setAttribute("height", "12"); swatch.setAttribute("aria-hidden", "true");
    dot.setAttribute("cx", "6"); dot.setAttribute("cy", "6"); dot.setAttribute("r", "5"); dot.setAttribute("fill", color(community));
    swatch.append(dot); entry.append(swatch, document.createTextNode(`Community ${community + 1} · ${members.length}`)); container.append(entry);
  }
}

function renderNodes(graph: SVGSVGElement, view: RunView, selection: Selection, points: ReadonlyMap<SteamId, { x: number; y: number }>, foundIds: ReadonlySet<SteamId>, inspect: (id: SteamId) => void, focused: string | null | undefined) {
  const query = selection.query.trim();
  const players = new Map(view.scan.players.map((player) => [player.id, player]));
  for (const metric of view.report.metrics) {
    const point = points.get(metric.id); if (!point) continue;
    const player = players.get(metric.id); const name = player?.name ?? metric.id;
    const node = svgElement("g"); const circle = svgElement("circle"); const title = svgElement("title");
    node.setAttribute("role", "button"); node.setAttribute("tabindex", "0"); node.setAttribute("aria-label", `${name}, degree ${metric.degree}${metric.hub ? ", hub" : ""}`);
    node.setAttribute("data-node-id", metric.id);
    node.setAttribute("opacity", query && !foundIds.has(metric.id) ? ".25" : "1");
    circle.setAttribute("cx", String(point.x)); circle.setAttribute("cy", String(point.y)); circle.setAttribute("r", metric.hub ? "13" : "10");
    circle.setAttribute("fill", color(metric.community)); circle.setAttribute("stroke", metric.id === selection.id ? "#fff" : "#282e22"); circle.setAttribute("stroke-width", "2");
    title.textContent = `${name} · ${metric.degree} connections${metric.hub ? " · hub" : ""}`; node.append(circle, title);
    if (view.scan.players.length <= 80 && player?.avatar) {
      const image = svgElement("image"); image.setAttribute("href", player.avatar); image.setAttribute("x", String(point.x - 7)); image.setAttribute("y", String(point.y - 7)); image.setAttribute("width", "14"); image.setAttribute("height", "14");
      image.addEventListener("error", () => image.remove()); node.append(image);
    }
    if (view.scan.players.length <= 30 || metric.id === selection.id || (query && foundIds.has(metric.id))) {
      const label = svgElement("text"); label.textContent = name; label.setAttribute("x", String(point.x + 14)); label.setAttribute("y", String(point.y + 4)); node.append(label);
    }
    node.addEventListener("click", () => inspect(metric.id));
    node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspect(metric.id); } }); graph.append(node);
    if (metric.id === focused) node.focus();
  }
}

export interface Selection { readonly id: SteamId | null; readonly zoom: number; readonly query: string; readonly edges: string }

/** All labels are text nodes; avatar URLs have already passed the shared provider schema. */
export function render(graph: SVGSVGElement, legend: HTMLElement, matches: HTMLElement, count: HTMLElement, view: RunView, selection: Selection, inspect: (id: SteamId) => void) {
  const focused = document.activeElement?.getAttribute("data-node-id");
  graph.replaceChildren(); matches.replaceChildren();
  const { groups, points } = layout(view);
  renderLegend(legend, groups);
  const query = selection.query.trim().toLowerCase();
  const found = view.scan.players.filter((player) => player.name.toLowerCase().includes(query) || player.id.includes(query));
  const foundIds = new Set(found.map((player) => player.id));
  if (query) {
    for (const player of found.slice(0, 20)) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = player.name;
      button.title = player.id; button.addEventListener("click", () => inspect(player.id)); matches.append(button);
    }
    const status = document.createElement("span"); status.textContent = `${found.length} matching profiles${found.length > 20 ? ", first 20 shown" : ""}`; matches.append(status);
  }
  const edges = view.report.edges.filter((edge) => selection.edges === "all" || edge.kind === selection.edges);
  const shown = selection.id ? edges.filter((edge) => edge.source === selection.id || edge.target === selection.id) : edges;
  for (const edge of shown.slice(0, 1500)) {
    const from = points.get(edge.source); const to = points.get(edge.target); if (!from || !to) continue;
    const line = svgElement("line");
    line.setAttribute("x1", String(from.x)); line.setAttribute("y1", String(from.y)); line.setAttribute("x2", String(to.x)); line.setAttribute("y2", String(to.y));
    line.setAttribute("stroke", edge.kind === "friend" ? "#879b76" : "#aa9767"); graph.append(line);
  }
  renderNodes(graph, view, selection, points, foundIds, inspect, focused);
  setZoom(graph, view, selection.zoom);
  count.textContent = `${view.scan.players.length} profiles · ${Math.min(shown.length, 1500)}/${shown.length} edges drawn`;
}
