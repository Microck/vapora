import Graph from "graphology";
import Sigma from "sigma";
import { layerFill } from "sigma/rendering";
import { layerBorder } from "@sigma/node-border";
import type { StylesDeclaration } from "sigma/types";
import { NodePictures } from "./network-images.js";
import type { Player, SteamId } from "../src/model.js";
import type { RunView } from "../src/contracts.js";
import type { LayoutFrame, LayoutNode } from "./network-layout.js";

// Muted community colours belong to the graph, while the surrounding controls keep Steam's palette.
const colors = ["#a9c48a", "#d6bc72", "#87b3c1", "#c58f80", "#b2a0c5", "#80b59f", "#d3a377", "#9caed0", "#c8a8b7", "#c5c88a", "#7dbdbc", "#bfa9da", "#d1c3a2", "#8ea384", "#b79c7e", "#98bacb"];
export const communityColor = (community: number) => colors[community % colors.length] ?? "#d8ded3";
type Node = LayoutNode & { label: string; search: string; color: string; community: number; degree: number; groupDegree: number; image: string; baseSize: number };
type Edge = { kind: RunView["report"]["edges"][number]["kind"]; color: string; size: number };
interface NodeState { dim: boolean; selected: boolean; focus: boolean; match: boolean; labels: boolean }
interface EdgeState { dim: boolean; active: boolean }
export interface Filters { query: string; kind: string; community: string; scope: string; minimum: number; availability: string }
const defaults: Filters = { query: "", kind: "friend", community: "all", scope: "all", minimum: 0, availability: "all" };

/** One renderer owns both the embedded preview and the expanded in-app explorer. All data stays local. */
export class Viewer {
  readonly graph = new Graph<Node, Edge>({ type: "undirected", multi: true });
  readonly players: ReadonlyMap<string, Player>;
  readonly renderer: Sigma<Node, Edge, {}, NodeState, EdgeState>;
  readonly communities = new Map<number, number>();
  filters = { ...defaults };
  selected: string | null = null;
  private hovered: string | null = null;
  private visible = new Set<string>();
  private highlighted = new Set<string>();
  private activeEdges = new Set<string>();
  private focused = new Set<string>();
  private found = new Set<string>();
  private worker: Worker | null = null;
  private settled = false;
  private disposed = false;
  private labels = true;
  private size = 1;
  private visibleEdges = 0;
  private layoutStatus = "Arranging…";
  private hoverFrame = 0;
  private readonly pictures: NodePictures;
  onChange = () => {};

  constructor(readonly container: HTMLElement, readonly view: RunView, readonly inspect: (id: SteamId) => void) {
    this.players = new Map(view.scan.players.map((player) => [player.id, player]));
    // Deterministic disc positions are only an initial condition for the edge-based layout.
    for (const [index, metric] of view.report.metrics.entries()) {
      const angle = index * Math.PI * (3 - Math.sqrt(5)); const radius = Math.sqrt(index + 1) * 10;
      const label = this.players.get(metric.id)?.name ?? metric.id; const size = 2 + Math.min(4, Math.sqrt(metric.degree) * .3);
      this.graph.addNode(metric.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius,
        label, search: `${label.toLowerCase()} ${metric.id}`, color: communityColor(metric.community), image: "",
        community: metric.community, degree: metric.degree, groupDegree: 0, fixed: false, size, baseSize: size });
      this.communities.set(metric.community, (this.communities.get(metric.community) ?? 0) + 1);
    }
    for (const [index, edge] of view.report.edges.entries()) {
      this.graph.addUndirectedEdgeWithKey(String(index), edge.source, edge.target,
        { kind: edge.kind, size: .5, color: edge.kind === "friend" ? "#7c8b68" : "#a89768" });
      if (edge.kind === "group") {
        this.graph.setNodeAttribute(edge.source, "groupDegree", this.graph.getNodeAttribute(edge.source, "groupDegree") + 1);
        this.graph.setNodeAttribute(edge.target, "groupDegree", this.graph.getNodeAttribute(edge.target, "groupDegree") + 1);
      }
    }
    this.pictures = new NodePictures();
    /* oxlint-disable unicorn/no-thenable -- Sigma style conditions require non-callable then values. */
    const styles: StylesDeclaration<Node, Edge, NodeState, EdgeState> = {
      nodes: {
        x: { attribute: "x" }, y: { attribute: "y" }, label: { attribute: "label" },
        size: { whenState: "selected", then: 14, else: { attribute: "size" } },
        color: { whenState: "selected", then: "#f3e497", else: { attribute: "color" } },
        opacity: { whenState: "dim", then: .2, else: 1 }, visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
        depth: { whenState: "selected", then: "topNodes", else: "nodes" }, labelDepth: { whenState: "focus", then: "topNodes", else: "nodes" },
        labelColor: "#d8ded3", labelFont: "MotivaSans, Arial, sans-serif",
        labelVisibility: { whenState: "focus", then: "visible", else: { whenState: "match", then: "visible", else: { whenState: "labels", then: "auto", else: "hidden" } } },
        backdropVisibility: { whenState: "focus", then: "visible", else: "hidden" },
        backdropColor: "#3e4637", backdropShadowBlur: 0, backdropCornerRadius: 0, backdropPadding: 4,
      },
      edges: {
        color: { whenState: "active", then: "#d8cc75", else: { attribute: "color" } },
        opacity: { whenState: "active", then: 1, else: { whenState: "dim", then: .08, else: .25 } },
        size: { whenState: "active", then: 1.3, else: .5 },
        visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
        depth: { whenState: "active", then: "topEdges", else: "edges" },
      },
    };
    /* oxlint-enable unicorn/no-thenable */
    this.renderer = new Sigma<Node, Edge, {}, NodeState, EdgeState>(this.graph, container, {
      customNodeState: { dim: false, selected: false, focus: false, match: false, labels: true },
      customEdgeState: { dim: false, active: false },
      settings: { allowInvalidContainer: true, nodeLabelEvents: false, enableNodeDrag: true, autoRescale: "once", autoRescaleContent: "nodes", stagePadding: 24,
        zoomDuration: 0, inertiaDuration: 0, doubleClickZoomingDuration: 0, minCameraRatio: .015, maxCameraRatio: 8,
        zoomToSizeRatioFunction: Math.sqrt, labelDensity: .3, labelRenderedSizeThreshold: 5, hideLabelsOnMove: true, gestureTarget: "graph" },
      primitives: { nodes: { variables: { image: { type: "string", default: "" } },
        layers: [layerFill(), this.pictures.layer, layerBorder({ borders: [
          { size: 1.5, color: { attribute: "color" }, mode: "pixels", fill: false },
          { size: 0, color: "#00000000", fill: true },
        ] })],
        label: { font: { family: "MotivaSans, Arial, sans-serif", size: 12 } } } },
      // State declarations let Sigma patch dirty GPU entries instead of re-indexing the graph on hover.
      styles,
    });
    this.pictures.attach(this.renderer, this.players, (images) => {
      // Sigma's batch handler can patch image attributes without rebuilding node/edge indexes.
      this.graph.updateEachNodeAttributes((id, node) => {
        const image = images.get(id); return image === undefined ? node : { ...node, image };
      }, { attributes: ["image"] });
    });
    this.recalculate();
    this.renderer.on("clickNode", ({ node }) => { this.select(node); });
    this.renderer.on("doubleClickNode", ({ node, preventSigmaDefault }) => { preventSigmaDefault(); this.details(node); });
    this.renderer.on("downStage", () => this.pause());
    this.renderer.on("wheelStage", () => this.pause());
    this.renderer.on("wheelNode", () => this.pause());
    this.renderer.on("clickStage", () => { if (this.selected) this.select(null); });
    this.renderer.on("enterNode", ({ node }) => this.hover(node));
    this.renderer.on("leaveNode", () => this.hover(null));
    this.renderer.on("nodeDragStart", ({ node }) => { this.settled = false; this.pause(); this.graph.setNodeAttribute(node, "fixed", true); this.onChange(); });
    this.renderer.getCamera().on("updated", (state) => { container.dataset.ratio = String(state.ratio); });
    this.renderer.on("webglContextLost", () => { this.pause(); this.layoutStatus = "Graphics context lost. Reload this page to retry."; this.onChange(); });
    container.dataset.ratio = "1";
    this.layout();
  }

  private edgeVisible(source: string, target: string, kind: string) {
    return this.visible.has(source) && this.visible.has(target) && (this.filters.kind === "all" || this.filters.kind === kind);
  }
  private neighbourhood(id: string, hops: number): Set<string> {
    const members = new Set([id]); let frontier = [id];
    for (let hop = 0; hop < hops; hop++) {
      const next: string[] = [];
      for (const source of frontier) this.graph.forEachEdge(source, (_key, edge, from, to) => {
        if (this.filters.kind !== "all" && edge.kind !== this.filters.kind) return;
        const target = from === source ? to : from;
        if (!members.has(target)) { members.add(target); next.push(target); }
      });
      frontier = next;
    }
    return members;
  }
  private recalculate() {
    const filters = this.filters; const query = filters.query.trim().toLowerCase();
    const neighbourhood = this.selected && filters.scope !== "all" ? this.neighbourhood(this.selected, filters.scope === "two" ? 2 : 1) : null;
    this.visible.clear(); this.found.clear(); this.visibleEdges = 0;
    this.graph.forEachNode((id, node) => {
      const player = this.players.get(id);
      if ((filters.community !== "all" && node.community !== Number(filters.community)) || (filters.kind === "group" ? node.groupDegree : filters.kind === "all" ? node.degree + node.groupDegree : node.degree) < filters.minimum
        || (filters.availability !== "all" && player?.friendsStatus !== filters.availability) || (neighbourhood && !neighbourhood.has(id))) return;
      this.visible.add(id);
      if (query && node.search.includes(query)) this.found.add(id);
    });
    this.graph.forEachNode((id) => this.renderer.setNodeState(id, { isHidden: !this.visible.has(id), match: this.found.has(id) }));
    this.graph.forEachEdge((key, edge, from, to) => {
      const visible = this.edgeVisible(from, to, edge.kind); if (visible) this.visibleEdges++;
      this.renderer.setEdgeState(key, { isHidden: !visible });
    });
    this.container.dataset.nodes = String(this.visible.size); this.container.dataset.edges = String(this.visibleEdges);
    this.container.dataset.selected = this.selected ?? "";
    this.pictures.request();
    this.highlight();
  }
  private hover(id: string | null) {
    this.hovered = id; this.container.dataset.hovered = id ?? "";
    // Leaving A and entering B happen together. Apply their final state once per frame.
    if (!this.hoverFrame) this.hoverFrame = requestAnimationFrame(() => { this.hoverFrame = 0; this.highlight(); });
  }
  private highlight() {
    const highlighted: Set<string> = this.hovered ? this.neighbourhood(this.hovered, 1)
      : this.filters.query.trim() ? new Set(this.found) : this.selected ? this.neighbourhood(this.selected, 1) : new Set();
    const focus = this.hovered ?? this.selected; const activeEdges = new Set<string>(focus ? this.graph.edges(focus) : []);
    if (focus) this.pictures.request(focus);
    const dimChanged = Boolean(highlighted.size) !== Boolean(this.highlighted.size);
    const nodes = dimChanged ? this.graph.nodes() : new Set([...this.highlighted, ...highlighted]);
    const edges = dimChanged ? this.graph.edges() : new Set([...this.activeEdges, ...activeEdges]);
    for (const id of nodes) this.renderer.setNodeState(id, { dim: highlighted.size > 0 && !highlighted.has(id) });
    for (const key of edges) this.renderer.setEdgeState(key, { dim: highlighted.size > 0, active: activeEdges.has(key) });
    const focused = new Set<string>(); if (this.hovered) focused.add(this.hovered); if (this.selected) focused.add(this.selected);
    for (const id of new Set([...this.focused, ...focused])) this.renderer.setNodeState(id, { focus: focused.has(id), selected: id === this.selected });
    this.highlighted = highlighted; this.activeEdges = activeEdges; this.focused = focused;
  }
  update(filters: Partial<Filters>) {
    const next = { ...this.filters, ...filters };
    const queryOnly = next.kind === this.filters.kind && next.scope === this.filters.scope && next.community === this.filters.community
      && next.minimum === this.filters.minimum && next.availability === this.filters.availability;
    if (queryOnly && next.query === this.filters.query) return;
    this.filters = next;
    if (queryOnly) {
      const previous = this.found; this.found = new Set(); const query = next.query.trim().toLowerCase();
      if (query) for (const id of this.visible) if (this.graph.getNodeAttribute(id, "search").includes(query)) this.found.add(id);
      for (const id of new Set([...previous, ...this.found])) this.renderer.setNodeState(id, { match: this.found.has(id) });
      this.highlight();
    } else this.recalculate();
    this.onChange();
  }
  select(id: string | null, center = false) {
    this.selected = id;
    if (!id && this.filters.scope !== "all") this.filters = { ...this.filters, scope: "all" };
    if (this.filters.scope !== "all" || this.visible.size !== this.graph.order) this.recalculate();
    else this.highlight();
    this.container.dataset.selected = id ?? ""; this.onChange();
    if (center && id && this.visible.has(id)) {
      const node = this.renderer.getNodeDisplayData(id);
      if (node) this.renderer.getCamera().setState({ x: node.x, y: node.y, ratio: Math.min(.3, this.renderer.getCamera().ratio) });
    }
  }
  details(id = this.selected) { const player = id ? this.players.get(id) : undefined; if (player) this.inspect(player.id); }
  matches() {
    const ids = this.filters.query.trim() ? this.found : this.visible;
    return [...ids].map((id) => this.players.get(id)).filter((player) => player !== undefined);
  }
  summary() {
    const filtered = this.visible.size !== this.graph.order || this.visibleEdges !== this.graph.size;
    return `${this.visible.size.toLocaleString()} profiles · ${this.visibleEdges.toLocaleString()} connections${filtered ? ` shown of ${this.graph.order.toLocaleString()} / ${this.graph.size.toLocaleString()}` : ""}`;
  }
  visibleConnections(id: string) {
    let count = 0;
    this.graph.forEachEdge(id, (_key, edge, from, to) => { if (this.edgeVisible(from, to, edge.kind)) count++; });
    return count;
  }
  status() { return this.layoutStatus; }
  isRunning() { return this.worker !== null; }
  isSettled() { return this.settled; }
  isPinned() { return this.selected ? this.graph.getNodeAttribute(this.selected, "fixed") : false; }
  pin() { if (this.selected) { this.settled = false; this.pause(); this.graph.setNodeAttribute(this.selected, "fixed", !this.isPinned()); this.onChange(); } }
  zoom(factor: number) { const camera = this.renderer.getCamera(); camera.setState({ ratio: camera.getBoundedRatio(camera.ratio / factor) }); }
  fit() { this.renderer.getCamera().setState({ x: .5, y: .5, angle: 0, ratio: 1 }); }
  appearance(labels: boolean, size: number) {
    if (labels !== this.labels) {
      this.labels = labels; this.renderer.setNodesState(this.graph.nodes(), { labels });
    }
    if (size !== this.size) {
      this.size = size;
      this.pictures.request();
      this.graph.updateEachNodeAttributes((_id, node) => ({ ...node, size: node.baseSize * size }), { attributes: ["size"] });
    }
  }
  pause() { this.worker?.terminate(); this.worker = null; if (!this.settled) this.layoutStatus = "Layout paused"; this.onChange(); }
  layout() {
    this.pause(); this.settled = false; this.layoutStatus = "Arranging…";
    const worker = new Worker("/network-layout.js", { type: "module" }); this.worker = worker;
    worker.onmessage = (event: MessageEvent<LayoutFrame>) => {
      if (this.disposed || this.worker !== worker) return;
      let index = 0;
      // Safety: this bundled worker emits exactly two coordinates per node, in graph insertion order.
      this.graph.updateEachNodeAttributes((_id, node) => {
        const x = event.data.positions[index++]!; const y = event.data.positions[index++]!;
        return { ...node, x, y };
      }, { attributes: ["x", "y"] });
      // One fit after layout, with no reset of the user's camera.
      this.renderer.setSetting("autoRescale", "once");
      this.pictures.request();
      this.settled = true; worker.terminate(); this.worker = null; this.layoutStatus = "Layout settled";
      this.onChange();
    };
    worker.onerror = () => {
      if (this.disposed || this.worker !== worker) return;
      this.pause(); this.layoutStatus = "Layout failed. Choose Resume to retry."; this.onChange();
    };
    // Layout follows observed friendships, not the potentially dense shared-group projection.
    const layoutGraph = new Graph<LayoutNode>({ type: "undirected" });
    this.graph.forEachNode((id, node) => layoutGraph.addNode(id, { x: node.x, y: node.y, size: node.size, fixed: node.fixed }));
    this.graph.forEachEdge((_key, edge, from, to) => { if (edge.kind === "friend") layoutGraph.mergeEdge(from, to); });
    worker.postMessage(layoutGraph.export()); this.onChange();
  }
  /** Draw retained display geometry at export resolution, without a second GPU context or viewport bitmap. */
  image() {
    const { width, height } = this.renderer.getDimensions();
    const scale = 4096 / Math.max(width, height);
    const canvas = document.createElement("canvas"); canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d"); if (!context) throw new Error("Could not create the image. Try Save image again.");
    context.fillStyle = "#3e4637"; context.fillRect(0, 0, canvas.width, canvas.height); context.scale(scale, scale);
    const nodes = new Map([...this.visible].flatMap((id) => {
      const data = this.renderer.getNodeDisplayData(id);
      return data ? [[id, { data, point: this.renderer.framedGraphToViewport(data), radius: this.renderer.scaleSize(data.size) }] as const] : [];
    }));
    // Batch paths by their resolved visual style instead of issuing one stroke per connection.
    const paths = new Map<string, { path: Path2D; color: string; opacity: number; size: number; depth: string }>();
    this.graph.forEachEdge((key, _edge, from, to) => {
      const data = this.renderer.getEdgeDisplayData(key); const source = nodes.get(from); const target = nodes.get(to);
      if (!data || data.visibility === "hidden" || !source || !target) return;
      const style = JSON.stringify([data.color, data.opacity, data.size, data.depth]);
      let batch = paths.get(style);
      if (!batch) { batch = { path: new Path2D(), color: data.color, opacity: data.opacity, size: data.size, depth: data.depth }; paths.set(style, batch); }
      batch.path.moveTo(source.point.x, source.point.y); batch.path.lineTo(target.point.x, target.point.y);
    });
    for (const batch of [...paths.values()].sort((a, b) => Number(a.depth === "topEdges") - Number(b.depth === "topEdges"))) {
      context.strokeStyle = batch.color; context.globalAlpha = batch.opacity;
      context.lineWidth = Math.max(.5, this.renderer.scaleSize(batch.size)); context.stroke(batch.path);
    }
    const labels = this.renderer.getNodeDisplayedLabels();
    const ordered = [...nodes].sort(([a], [b]) => Number(a === this.selected) - Number(b === this.selected));
    for (const [id, { data, point, radius }] of ordered) {
      if (point.x + radius < 0 || point.x - radius > width || point.y + radius < 0 || point.y - radius > height) continue;
      context.globalAlpha = data.opacity; context.fillStyle = data.color;
      context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fill();
      const original = this.pictures.original(this.graph.getNodeAttribute(id, "image"));
      if (original) {
        // Use original loaded image pixels, not the small live GPU atlas thumbnail.
        context.save(); context.clip();
        const side = Math.min(original.naturalWidth, original.naturalHeight);
        context.drawImage(original, (original.naturalWidth - side) / 2, (original.naturalHeight - side) / 2, side, side,
          point.x - radius, point.y - radius, radius * 2, radius * 2); context.restore();
      }
      context.strokeStyle = this.graph.getNodeAttribute(id, "color"); context.lineWidth = 1.5; context.stroke();
    }
    // Text is painted after circles so labels remain legible at every export scale.
    context.font = "12px MotivaSans, Arial, sans-serif"; context.textBaseline = "middle";
    for (const [id, { data, point, radius }] of ordered) {
      if (!labels.has(id) || !data.label) continue;
      context.globalAlpha = data.opacity;
      if (data.backdropVisibility === "visible") {
        context.fillStyle = "#3e4637"; context.fillRect(point.x + radius, point.y - 10, context.measureText(data.label).width + 8, 20);
      }
      context.fillStyle = data.labelColor; context.fillText(data.label, point.x + radius + 4, point.y);
    }
    return canvas;
  }
  destroy() { this.disposed = true; this.onChange = () => {}; this.pause(); cancelAnimationFrame(this.hoverFrame); this.pictures.destroy(); this.renderer.kill(); }
}
