/** One top-layer tooltip serves static and dynamically rendered controls, including dialogs. */
export function install(tooltip: HTMLElement) {
  // Help descriptions remain available to assistive technology while the popover is closed.
  for (const [index, anchor] of document.querySelectorAll<HTMLElement>(".info[data-tooltip]").entries()) {
    const description = document.createElement("span"); description.className = "sr-only";
    description.id = `help-description-${index}`; description.textContent = anchor.dataset.tooltip ?? "";
    const existing = anchor.getAttribute("aria-describedby");
    anchor.setAttribute("aria-describedby", existing ? `${existing} ${description.id}` : description.id);
    anchor.after(description);
  }
  let trigger: HTMLElement | null = null;
  let pinned = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  function findTrigger(target: EventTarget | null) {
    const anchor = target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;
    // A control can replace itself in its click handler before this delegated event arrives.
    if (!anchor || !anchor.isConnected) return null;
    const modal = document.querySelector("dialog:modal");
    return modal && !modal.contains(anchor) ? null : anchor;
  }

  function hide() {
    clearTimeout(hideTimer);
    if (trigger) {
      const descriptions = (trigger.getAttribute("aria-describedby") ?? "").split(" ").filter((id) => id && id !== tooltip.id);
      if (descriptions.length) trigger.setAttribute("aria-describedby", descriptions.join(" "));
      else trigger.removeAttribute("aria-describedby");
    }
    if (tooltip.matches(":popover-open")) tooltip.hidePopover();
    trigger = null; pinned = false;
  }

  function show(anchor: HTMLElement) {
    clearTimeout(hideTimer);
    if (anchor === trigger) return;
    hide(); trigger = anchor;
    // A modal makes outside elements inert, including a top-layer popover.
    // Keep help inside its dialog so hovering and scrolling remain usable.
    const container = anchor.closest("dialog:modal") ?? document.body;
    if (tooltip.parentElement !== container) container.append(tooltip);
    tooltip.textContent = anchor.dataset.tooltip ?? "";
    const descriptions = anchor.getAttribute("aria-describedby");
    if (!anchor.classList.contains("info") || !descriptions) {
      anchor.setAttribute("aria-describedby", descriptions ? `${descriptions} ${tooltip.id}` : tooltip.id);
    }
    tooltip.showPopover();
    const bounds = anchor.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    // Consider only adjacent positions. Empty space elsewhere in the window must
    // not pull help away from the control that explains it.
    const placements = [[bounds.right + 7, bounds.top], [bounds.left - box.width - 7, bounds.top],
      [bounds.left, bounds.top - box.height - 7], [bounds.left, bounds.bottom + 7]] as const;
    const surface = anchor.closest("dialog:modal") ?? document;
    // Focus-only containers such as the workspace are not action hit targets.
    const controls = [...surface.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((control) => !tooltip.contains(control)).map((control) => control.getBoundingClientRect())
      .filter((rect) => rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight);
    let smallestOverlap = Infinity;
    for (const [x, y] of placements) {
      const left = Math.max(8, Math.min(x, innerWidth - box.width - 8));
      const top = Math.max(8, Math.min(y, innerHeight - box.height - 8));
      const overlap = controls.reduce((total, rect) => total
        + Math.max(0, Math.min(left + box.width, rect.right) - Math.max(left, rect.left))
        * Math.max(0, Math.min(top + box.height, rect.bottom) - Math.max(top, rect.top)), 0);
      if (overlap >= smallestOverlap) continue;
      smallestOverlap = overlap; tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
      if (!overlap) break;
    }
  }

  function leave() {
    if (!trigger || pinned || trigger === document.activeElement) return;
    // A short bridge lets the pointer cross the gap and read the tooltip itself.
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 100);
  }
  document.addEventListener("pointerover", (event) => {
    if (tooltip.contains(event.target instanceof Node ? event.target : null)) { clearTimeout(hideTimer); return; }
    if (pinned) return;
    const anchor = findTrigger(event.target);
    if (anchor) show(anchor);
  });
  document.addEventListener("pointerout", (event) => {
    const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (trigger?.contains(related) || tooltip.contains(related)) return;
    if (findTrigger(event.target) === trigger || tooltip.contains(event.target instanceof Node ? event.target : null)) leave();
  });
  document.addEventListener("focusin", (event) => { const anchor = findTrigger(event.target); if (anchor) show(anchor); });
  document.addEventListener("focusout", (event) => {
    if (trigger?.contains(event.target instanceof Node ? event.target : null)) hide();
  });
  document.addEventListener("click", (event) => {
    if (tooltip.contains(event.target instanceof Node ? event.target : null)) return;
    const anchor = findTrigger(event.target);
    if (!anchor) { hide(); return; }
    if (anchor === trigger && pinned) { hide(); return; }
    show(anchor); pinned = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !trigger) return;
    hide(); event.preventDefault(); event.stopPropagation();
  }, true);
  document.addEventListener("scroll", (event) => {
    // Reading overflowing help must not dismiss it; scrolling the page still does.
    if (!tooltip.contains(event.target instanceof Node ? event.target : null)) hide();
  }, true);
  window.addEventListener("resize", hide);
}
