import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { SerializedGraph } from "graphology-types";

export type LayoutNode = { x: number; y: number; size: number; fixed: boolean };
export interface LayoutFrame { readonly positions: Float32Array }

// A real module worker keeps the CSP restricted to bundled scripts, without blob/eval workers.
self.onmessage = (event: MessageEvent<SerializedGraph<LayoutNode>>) => {
  const graph = new Graph<LayoutNode>(); graph.import(event.data);
  const settings = { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: true, scalingRatio: 12, gravity: 1, slowDown: 5 };
  // Keep ForceAtlas2's working matrices for the whole run, rather than rebuilding them every ten iterations.
  // Terminating the worker still cancels this synchronous calculation immediately from the main thread.
  forceAtlas2.assign(graph, { iterations: 300, settings });
  const positions = new Float32Array(graph.order * 2); let index = 0;
  graph.forEachNode((_id, node) => { positions[index++] = node.x; positions[index++] = node.y; });
  self.postMessage({ positions } satisfies LayoutFrame, { transfer: [positions.buffer] });
  self.close();
};
