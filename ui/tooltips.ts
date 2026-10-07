/** One top-layer tooltip serves static and dynamically rendered controls, including dialogs. */
export function install(tooltip: HTMLElement) {
  let trigger: HTMLElement | null = null;
  let pinned = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  function findTrigger(target: EventTarget | null) {
    const anchor = target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;
    if (!anchor) return null;
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
    tooltip.textContent = anchor.dataset.tooltip ?? "";
    const descriptions = anchor.getAttribute("aria-describedby");
    anchor.setAttribute("aria-describedby", descriptions ? `${descriptions} ${tooltip.id}` : tooltip.id);
    tooltip.showPopover();
    const bounds = anchor.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(bounds.left, innerWidth - box.width - 8));
    const below = bounds.bottom + 7;
    const top = below + box.height <= innerHeight - 8 ? below : Math.max(8, bounds.top - box.height - 7);
    tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
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
    const anchor = findTrigger(event.target);
    if (!anchor) { hide(); return; }
    if (anchor === trigger && pinned) { hide(); return; }
    show(anchor); pinned = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !trigger) return;
    hide(); event.preventDefault(); event.stopPropagation();
  }, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}
