import { Viewer } from "./network.js";
import * as Details from "./details.js";
import type { RunView } from "../src/contracts.js";
import type { SteamId } from "../src/model.js";

/** The same mounted canvas expands in-app; camera, filters and selection never need copying. */
export class Explorer {
  readonly viewer: Viewer;
  private expanded = false;
  private resumeLayout = false;
  private filtersOpen = innerWidth > 680;
  private page = 0;
  private profileSignature = "";
  private selectionSignature = "";
  private updateFrame = 0;
  private readonly events = new AbortController();
  private readonly occluded = new Set<HTMLElement>();
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented && this.expanded && !document.querySelector(".details-window:focus-within, #app-tooltip:popover-open")) {
      event.preventDefault(); this.maximize(false);
    }
  };
  private get(id: string) { const element = this.root.querySelector<HTMLElement>(`#${id}`); if (!element) throw new Error(`Missing network control: ${id}`); return element; }
  private input(id: string) { const element = this.get(id); if (!(element instanceof HTMLInputElement)) throw new Error(`Expected input: ${id}`); return element; }
  private select(id: string) { const element = this.get(id); if (!(element instanceof HTMLSelectElement)) throw new Error(`Expected select: ${id}`); return element; }
  private button(id: string) { const element = this.get(id); if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected button: ${id}`); return element; }
  private click(id: string, callback: () => void) { this.get(id).addEventListener("click", callback, { signal: this.events.signal }); }

  constructor(readonly root: HTMLElement, readonly view: RunView) {
    const graph = this.get("graph"); graph.replaceChildren();
    this.viewer = new Viewer(graph, view, (id) => Details.profile(view, id, () => graph));
    const communities = this.select("network-community"); communities.replaceChildren(new Option("All communities", "all"));
    for (const [id, count] of [...this.viewer.communities].sort(([a], [b]) => a - b)) communities.add(new Option(`Community ${id + 1} · ${count}`, String(id)));
    this.viewer.onChange = () => this.render();
    this.click("network-maximize", () => this.maximize(!this.expanded));
    this.click("zoom-in", () => { this.viewer.pause(); this.viewer.zoom(1.5); });
    this.click("zoom-out", () => { this.viewer.pause(); this.viewer.zoom(1 / 1.5); });
    this.click("zoom-reset", () => this.viewer.fit());
    this.click("network-filters", () => { this.filtersOpen = !this.filtersOpen; this.resize(); });
    this.click("network-pause", () => { if (this.viewer.isRunning()) this.viewer.pause(); else this.viewer.layout(); });
    this.click("network-clear", () => this.reset());
    this.click("network-export", () => this.exportImage());
    this.click("network-previous", () => { this.page--; this.renderProfiles(); });
    this.click("network-next", () => { this.page++; this.renderProfiles(); });
    for (const id of ["network-search", "network-minimum"]) {
      this.input(id).addEventListener("input", () => {
        if (!this.updateFrame) this.updateFrame = requestAnimationFrame(() => { this.updateFrame = 0; this.update(); });
      }, { signal: this.events.signal });
    }
    for (const id of ["network-size", "network-labels"]) {
      this.input(id).addEventListener("input", () => this.viewer.appearance(this.expanded && this.input("network-labels").checked, this.input("network-size").valueAsNumber), { signal: this.events.signal });
    }
    for (const id of ["edge-kind", "network-community", "network-scope", "network-availability"]) {
      this.select(id).addEventListener("change", () => this.update(), { signal: this.events.signal });
    }
    graph.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); this.viewer.details(this.viewer.selected ?? view.scan.seed); }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); this.viewer.pause(); this.viewer.zoom(1.5); }
      if (event.key === "-") { event.preventDefault(); this.viewer.pause(); this.viewer.zoom(1 / 1.5); }
      if (event.key === "Home") { event.preventDefault(); this.viewer.fit(); }
      const movement = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
      if (movement) { event.preventDefault(); this.viewer.pause(); const camera = this.viewer.renderer.getCamera(); camera.setState({ x: camera.x + (movement[0] ?? 0) * .05 * camera.ratio, y: camera.y + (movement[1] ?? 0) * .05 * camera.ratio }); }
    }, { signal: this.events.signal });
    document.addEventListener("keydown", this.keydown, { signal: this.events.signal });
    matchMedia("(max-width: 680px)").addEventListener("change", (event) => { this.filtersOpen = !event.matches; this.resize(); }, { signal: this.events.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.suspendLayout();
      else if (this.root.checkVisibility()) this.show();
    }, { signal: this.events.signal });
    window.addEventListener("pagehide", () => this.destroy(), { once: true, signal: this.events.signal });
    for (const [id, file] of [["network-nodes-export", "gephi/nodes.csv"], ["network-edges-export", "gephi/edges.csv"]]) {
      if (!id || !file) continue;
      this.get(id).setAttribute("href", `/api/download?id=${encodeURIComponent(view.scan.id)}&file=${encodeURIComponent(file)}`);
      this.get(id).setAttribute("download", "");
    }
    this.root.querySelector<HTMLElement>(".network-data-exports")?.toggleAttribute("hidden", view.scan.status !== "complete");
    this.reset();
  }
  private update() {
    this.page = 0;
    const minimum = this.input("network-minimum");
    // Native input validation handles partial/negative edits without silently changing the filter.
    if (!minimum.validity.valid || !Number.isFinite(minimum.valueAsNumber)) return;
    this.viewer.update({ query: this.input("network-search").value, kind: this.select("edge-kind").value,
      community: this.select("network-community").value, scope: this.select("network-scope").value,
      minimum: minimum.valueAsNumber, availability: this.select("network-availability").value });
    this.viewer.appearance(this.expanded && this.input("network-labels").checked, this.input("network-size").valueAsNumber);
  }
  private reset() {
    this.input("network-search").value = ""; this.input("network-minimum").value = "0"; this.input("network-size").value = "1";
    this.input("network-labels").checked = true;
    this.select("edge-kind").value = "friend";
    for (const id of ["network-community", "network-scope", "network-availability"]) this.select(id).value = "all";
    this.viewer.select(null); this.update(); this.viewer.fit();
  }
  private render() {
    this.get("graph-count").textContent = this.viewer.summary();
    this.get("network-layout-status").textContent = this.viewer.container.dataset.nodes === "0" ? "No profiles match these filters." : this.viewer.status();
    this.button("network-pause").disabled = this.viewer.isSettled();
    this.button("network-pause").textContent = this.viewer.isRunning() || this.viewer.isSettled() ? "Pause" : "Resume";
    this.select("network-scope").disabled = !this.viewer.selected;
    this.select("network-scope").value = this.viewer.filters.scope;
    this.renderSelection(); this.renderProfiles();
  }
  private renderSelection() {
    const connections = this.viewer.selected ? this.viewer.visibleConnections(this.viewer.selected) : 0;
    const signature = JSON.stringify([this.viewer.selected, this.viewer.isPinned(), connections]);
    if (signature === this.selectionSignature) return;
    this.selectionSignature = signature;
    const container = this.get("network-selection"); container.replaceChildren();
    const player = this.viewer.selected ? this.viewer.players.get(this.viewer.selected) : undefined;
    if (!player) { container.textContent = `${this.viewer.communities.size} communities`; return; }
    const name = document.createElement("strong"); name.textContent = player.name;
    const count = document.createElement("span"); count.textContent = `${connections} visible connections`;
    const details = document.createElement("button"); details.type = "button"; details.textContent = "Details";
    details.addEventListener("click", () => Details.profile(this.view, player.id, () => this.root.querySelector<HTMLButtonElement>(`#network-selection [data-node-id="${player.id}"]`)));
    details.dataset.nodeId = player.id;
    const pin = document.createElement("button"); pin.type = "button"; pin.textContent = this.viewer.isPinned() ? "Unpin" : "Pin";
    pin.setAttribute("aria-pressed", String(this.viewer.isPinned())); pin.addEventListener("click", () => this.viewer.pin());
    container.append(Details.avatar(player.avatar), name, count, details, pin);
  }
  private profileButton(id: SteamId, name: string, image: string | null, details: boolean) {
    const button = document.createElement("button"); button.type = "button"; button.dataset.nodeId = id;
    button.append(Details.avatar(image), document.createTextNode(name)); button.setAttribute("aria-label", `${details ? "Details for" : "Select"} ${name}`);
    button.setAttribute("aria-pressed", String(id === this.viewer.selected));
    button.addEventListener("click", () => {
      this.viewer.pause(); this.viewer.select(id, true);
      if (details) Details.profile(this.view, id, () => this.root.querySelector<HTMLButtonElement>(`#network-matches [data-node-id="${id}"]`));
    });
    return button;
  }
  private renderProfiles() {
    const signature = JSON.stringify([this.viewer.filters, this.viewer.selected, this.expanded, this.page, this.viewer.graph.order]);
    if (signature === this.profileSignature) return;
    this.profileSignature = signature;
    const focused = document.activeElement;
    const focusedId = focused?.getAttribute("data-node-id");
    const matches = this.get("network-matches"); const profiles = this.get("network-profiles");
    matches.replaceChildren(); profiles.replaceChildren();
    const found = this.viewer.matches();
    if (!this.expanded) {
      if (this.viewer.filters.query.trim()) {
        for (const player of found.slice(0, 5)) matches.append(this.profileButton(player.id, player.name, player.avatar, true));
        const count = document.createElement("span"); count.textContent = `${found.length} matches`; matches.append(count);
      }
      return;
    }
    this.page = Math.max(0, Math.min(this.page, Math.ceil(found.length / 50) - 1));
    const start = this.page * 50;
    for (const player of found.slice(start, start + 50)) profiles.append(this.profileButton(player.id, player.name, player.avatar, false));
    if (!found.length) profiles.textContent = "No matching profiles.";
    this.get("network-profile-count").textContent = found.length ? `${start + 1}–${Math.min(start + 50, found.length)} / ${found.length}` : "0";
    this.button("network-previous").disabled = this.page === 0;
    this.button("network-next").disabled = start + 50 >= found.length;
    if (focusedId && focused?.closest("#network-profiles")) profiles.querySelector<HTMLButtonElement>(`[data-node-id="${focusedId}"]`)?.focus({ preventScroll: true });
  }
  private resize() {
    this.get("network-sidebar").hidden = !this.expanded || !this.filtersOpen;
    this.button("network-filters").setAttribute("aria-expanded", String(this.filtersOpen));
    const { width, height } = this.viewer.renderer.getDimensions(); const graph = this.get("graph");
    if (width !== graph.clientWidth || height !== graph.clientHeight) { this.viewer.renderer.resize(); this.viewer.renderer.scheduleRender(); }
  }
  private occlude(expanded: boolean) {
    // The enlarged panel is a view, not a modal: native window controls, progress and Details stay usable.
    for (const element of this.occluded) element.inert = false;
    this.occluded.clear();
    if (!expanded) return;
    for (let branch: HTMLElement | null = this.root; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === branch || sibling.inert
          || sibling.matches(".titlebar, #progress-section, #app-tooltip, .details-window")) continue;
        sibling.inert = true; this.occluded.add(sibling);
      }
      if (branch.parentElement === document.body) break;
    }
  }
  maximize(expanded: boolean) {
    this.expanded = expanded; this.occlude(expanded); this.root.classList.toggle("network-expanded", expanded);
    document.body.classList.toggle("network-is-expanded", expanded);
    const button = this.button("network-maximize"); button.setAttribute("aria-expanded", String(expanded));
    const label = button.querySelector("span:last-child"); if (label) label.textContent = expanded ? "Restore view" : "Maximize view";
    button.querySelector(".window-glyph")?.classList.toggle("restore-glyph", expanded);
    this.viewer.appearance(expanded && this.input("network-labels").checked, this.input("network-size").valueAsNumber);
    this.resize(); this.render(); button.focus({ preventScroll: true });
  }
  private suspendLayout() { this.resumeLayout ||= this.viewer.isRunning(); this.viewer.pause(); }
  show() { this.resize(); if (this.resumeLayout) { this.resumeLayout = false; this.viewer.layout(); } }
  hide() { if (this.expanded) this.maximize(false); this.suspendLayout(); }
  destroy() { this.hide(); cancelAnimationFrame(this.updateFrame); this.events.abort(); this.viewer.destroy(); this.get("graph").replaceChildren(); }
  private exportImage() {
    const button = this.button("network-export"); button.disabled = true; button.textContent = "Saving…";
    const fail = () => { this.get("network-layout-status").textContent = "Could not save the image. Try Save image again."; };
    const finish = () => { button.disabled = false; button.textContent = "Save image"; };
    // Resolve pending styles before reading display geometry. Export never changes the camera or layout.
    this.viewer.renderer.once("afterRender", () => {
      try {
        this.viewer.image().toBlob((blob) => {
          if (!blob) { fail(); finish(); return; }
          const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url;
          link.download = `vapora-${this.view.scan.id}-network.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); finish();
        });
      } catch { fail(); finish(); }
    });
    this.viewer.renderer.scheduleRender();
  }
}
