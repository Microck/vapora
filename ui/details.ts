import type { Player, SteamId } from "../src/model.js";
import type { RunView } from "../src/contracts.js";

const availabilityLabels = { public: "Public", private: "Private", skipped: "Skipped", unavailable: "Unavailable", pending: "Not scanned", disabled: "Off" };

// Independent in-app windows avoid browser popup blockers and work in Electron too.
let layer = 20;
let sequence = 0;
const windows = new Set<HTMLElement>();
export type Opener = () => HTMLElement | SVGElement | null;

function position(window: HTMLElement, left: number, top: number) {
  window.style.left = `${Math.max(8, Math.min(left, innerWidth - window.offsetWidth - 8))}px`;
  window.style.top = `${Math.max(8, Math.min(top, innerHeight - window.offsetHeight - 8))}px`;
}

/** Each click owns its content, position and close lifecycle; other details stay open. */
export function open(title: string, contents: HTMLElement, resolveOpener: Opener, identity?: string) {
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
    const target = resolveOpener();
    if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
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

export function record<T>(title: string, value: T, resolveOpener: Opener) {
  const contents = document.createElement("pre"); contents.className = "details-record";
  contents.textContent = JSON.stringify(value, null, 2);
  return open(title, contents, resolveOpener);
}

window.addEventListener("resize", () => {
  for (const panel of windows) position(panel, panel.offsetLeft, panel.offsetTop);
});

function rankingFacts(selected: RunView, id: SteamId): readonly (readonly [string, string | number])[] {
  const rank = selected?.report.friends.find((friend) => friend.id === id);
  return rank ? [
    ["Incoming mutuals", rank.incomingMutual], ["Undirected mutuals", rank.mutual],
    ["Count index / 100", rank.countIndex?.toFixed(2) ?? "Unknown"], ["Reference friends", selected?.report.coverage.directFriends ?? 0],
    ["Game Jaccard", rank.gameJaccard?.toFixed(4) ?? "Unknown"], ["Group Jaccard", rank.groupJaccard?.toFixed(4) ?? "Unknown"],
  ] : [];
}
function profileFacts(player: Player, metric: RunView["report"]["metrics"][number] | undefined): readonly (readonly [string, string | number])[] {
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
export function profile(selected: RunView, account: SteamId, resolveOpener: Opener) {
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
  text.append(heading, link); identity.append(avatar(player?.avatar ?? null), text);
  const facts = document.createElement("dl"); facts.className = "details-facts";
  const fields = player ? profileFacts(player, metric) : [["Collection", "Outside admitted graph"]] as const;
  for (const [label, value] of [...fields, ...rankingFacts(selected, id)]) {
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = String(value); facts.append(term, detail);
  }
  contents.append(identity, facts); open(`Details for ${name}`, contents, resolveOpener, id);
}

/** A missing or failed Steam image keeps the same square placeholder, without repeated retries. */
export function setAvatar(image: HTMLImageElement, url: string | null) {
  image.onerror = url ? () => { image.onerror = null; image.src = "/placeholder.jpg"; } : null;
  image.referrerPolicy = "no-referrer"; image.alt = ""; image.src = url ?? "/placeholder.jpg";
}
export function avatar(url: string | null) {
  const image = document.createElement("img"); image.className = "profile-avatar"; image.width = 24; image.height = 24;
  setAvatar(image, url); return image;
}
