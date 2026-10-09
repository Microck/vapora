import { layerImage } from "@sigma/node-image";
import type Sigma from "sigma";
import type { Attributes } from "graphology-types";
import type { Player } from "../src/model.js";

/** GPU atlas images load only for readable nodes in the viewport, with six requests at a time. */
export class NodePictures {
  readonly layer = layerImage({ textureManagerOptions: {
    size: { mode: "force", value: 48 }, maxTextureSize: 2048, debounceTimeout: 120, crossOrigin: "anonymous",
  } });
  private readonly requested = new Set<string>();
  private readonly sources = new Map<string, Promise<string>>();
  private readonly active = new Map<HTMLImageElement, ReturnType<typeof setTimeout>>();
  private readonly queue: { source: string; resolve: (source: string) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = true;
  private applyFrame = 0;
  private readonly pending = new Map<string, string>();
  private disposed = false;

  request(id?: string) { if (!id || !this.requested.has(id)) this.dirty = true; }

  attach<N extends Attributes, E extends Attributes, NS, ES>(renderer: Sigma<N, E, {}, NS, ES>, players: ReadonlyMap<string, Player>, setImages: (images: ReadonlyMap<string, string>) => void) {
    const collect = () => {
      this.timer = null;
      if (this.disposed || document.hidden || !renderer.getContainer().checkVisibility()) return;
      this.dirty = false;
      const graph = renderer.getGraph(); const { width, height } = renderer.getDimensions();
      graph.forEachNode((id) => {
        if (this.requested.has(id) || renderer.getNodeState(id).isHidden) return;
        const node = renderer.getNodeDisplayData(id); if (!node) return;
        const radius = renderer.scaleSize(node.size); if (radius < 8) return;
        const point = renderer.framedGraphToViewport(node);
        if (point.x + radius < 0 || point.y + radius < 0 || point.x - radius > width || point.y - radius > height) return;
        this.requested.add(id);
        const source = players.get(id)?.avatar ?? "/placeholder.jpg";
        let ready = this.sources.get(source);
        if (!ready) {
          ready = new Promise<string>((resolve) => { this.queue.push({ source, resolve }); });
          this.sources.set(source, ready); this.load();
        }
        void ready.then((loaded) => {
          if (this.disposed) return;
          this.pending.set(id, loaded);
          if (!this.applyFrame) this.applyFrame = requestAnimationFrame(() => {
            this.applyFrame = 0; setImages(this.pending); this.pending.clear();
          });
        });
      });
    };
    renderer.getCamera().on("updated", () => this.request());
    renderer.on("resize", () => this.request());
    renderer.on("afterRender", () => {
      if (this.disposed || !this.dirty || this.requested.size === renderer.getGraph().order) return;
      if (this.timer !== null) clearTimeout(this.timer);
      // Wait until navigation pauses before requesting the newly visible pictures.
      this.timer = setTimeout(collect, 100);
    });
  }
  private load() {
    while (!this.disposed && this.active.size < 6 && this.queue.length) {
      const next = this.queue.shift(); if (!next) break;
      const image = new Image(); image.crossOrigin = "anonymous"; image.referrerPolicy = "no-referrer";
      const finish = (source: string) => {
        clearTimeout(this.active.get(image)); this.active.delete(image); image.onload = null; image.onerror = null;
        if (source !== image.src) image.src = "";
        next.resolve(source); this.load();
      };
      // A stalled CDN or failed local placeholder must not occupy a request slot forever.
      this.active.set(image, setTimeout(() => finish("/placeholder.jpg"), 15000));
      image.onerror = () => {
        if (new URL(image.src).pathname === "/placeholder.jpg") finish("");
        else image.src = "/placeholder.jpg";
      };
      image.onload = () => finish(image.src);
      image.src = next.source;
    }
  }
  destroy() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    cancelAnimationFrame(this.applyFrame); this.pending.clear();
    for (const [image, timer] of this.active) { clearTimeout(timer); image.onload = null; image.onerror = null; image.src = ""; }
    this.active.clear(); this.queue.length = 0; this.sources.clear(); this.requested.clear();
  }
}
