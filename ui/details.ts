// Independent in-app windows avoid browser popup blockers and work in Electron too.
let layer = 20;
let sequence = 0;
const windows = new Set<HTMLElement>();

function position(window: HTMLElement, left: number, top: number) {
  window.style.left = `${Math.max(8, Math.min(left, innerWidth - window.offsetWidth - 8))}px`;
  window.style.top = `${Math.max(8, Math.min(top, innerHeight - window.offsetHeight - 8))}px`;
}

/** Each click owns its content, position and close lifecycle; other details stay open. */
export function open(title: string, contents: HTMLElement, identity?: string) {
  const opener = document.activeElement;
  const window = document.createElement("section");
  window.className = "details-window"; window.tabIndex = -1;
  window.setAttribute("role", "dialog"); window.setAttribute("aria-modal", "false");
  if (identity) window.dataset.profile = identity;
  const heading = document.createElement("h2");
  heading.id = `details-title-${++sequence}`; heading.textContent = title;
  heading.tabIndex = 0; heading.setAttribute("role", "button");
  heading.setAttribute("aria-label", `Move ${title}; use arrow keys`);
  window.setAttribute("aria-labelledby", heading.id);
  const close = document.createElement("button"); close.type = "button";
  close.className = "details-close"; close.setAttribute("aria-label", `Close ${title}`);
  const glyph = document.createElement("span"); glyph.className = "window-glyph close-glyph";
  glyph.setAttribute("aria-hidden", "true"); close.append(glyph);
  const bar = document.createElement("header"); bar.className = "details-titlebar";
  bar.append(heading, close); contents.classList.add("details-content");
  window.append(bar, contents); document.body.append(window); windows.add(window);
  const raise = () => { window.style.zIndex = String(++layer); };
  const dismiss = () => {
    windows.delete(window); window.remove();
    if (opener instanceof HTMLElement && opener.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
  };
  close.addEventListener("click", dismiss);
  window.addEventListener("pointerdown", raise); window.addEventListener("focusin", raise);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
  });
  heading.addEventListener("keydown", (event) => {
    const movement = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!movement) return;
    event.preventDefault(); const distance = event.shiftKey ? 64 : 16;
    position(window, window.offsetLeft + (movement[0] ?? 0) * distance, window.offsetTop + (movement[1] ?? 0) * distance);
  });
  let dragging: { pointer: number; x: number; y: number } | null = null;
  heading.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = { pointer: event.pointerId, x: event.clientX - window.offsetLeft, y: event.clientY - window.offsetTop };
    heading.setPointerCapture(event.pointerId); event.preventDefault(); heading.focus({ preventScroll: true });
  });
  heading.addEventListener("pointermove", (event) => {
    if (dragging?.pointer === event.pointerId) position(window, event.clientX - dragging.x, event.clientY - dragging.y);
  });
  heading.addEventListener("lostpointercapture", () => { dragging = null; });
  const offset = (windows.size - 1) % 8 * 28;
  position(window, Math.max(8, (innerWidth - window.offsetWidth) / 2) + offset, 90 + offset);
  raise(); window.focus({ preventScroll: true });
  return window;
}

export function record<T>(title: string, value: T) {
  const contents = document.createElement("pre"); contents.className = "details-record";
  contents.textContent = JSON.stringify(value, null, 2);
  return open(title, contents);
}

window.addEventListener("resize", () => {
  for (const panel of windows) position(panel, panel.offsetLeft, panel.offsetTop);
});
