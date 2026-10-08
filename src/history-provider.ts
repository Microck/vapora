import { Effect, Schema, Scope } from "effect";
import { InputError } from "./model.js";
import type { SteamId } from "./model.js";
import * as History from "./history.js";

export const Response = Schema.Struct({ status: Schema.Number, contents: Schema.String });
export interface Response extends Schema.Schema.Type<typeof Response> {}
export interface Session { readonly request: (path: string) => Effect.Effect<Response, InputError> }
export type OpenSession = (id: SteamId) => Effect.Effect<Session, InputError, Scope.Scope>;
const sections = History.Section.literals;
const maxBytes = 2 * 1024 * 1024;
const pageLimit = 100;

const request = Effect.fn("History.request")(function* (session: Session, path: string) {
  const response = yield* session.request(path);
  if (response.status !== 200) return yield* Effect.fail(new InputError({ message: response.status === 403
    ? "History blocked this request. Retry or import a saved capture. Steam scanning is still available."
    : `History returned HTTP ${response.status}. Retry or import a saved capture.` }));
  return { path, contents: response.contents };
});
const profile = Effect.fn("History.profile")(function* (session: Session, id: SteamId) {
  const response = yield* request(session, `/id/${id}/__data.json`);
  const fields = yield* Effect.try({ try: () => History.summary(response.contents),
    catch: () => new InputError({ message: "History returned an unsupported profile response." }) });
  if (fields.steamID64 !== id) return yield* Effect.fail(new InputError({ message: "History returned another account. Nothing was saved." }));
  if (Buffer.byteLength(response.contents) > maxBytes / 2) return yield* Effect.fail(new InputError({ message: "History's profile exceeds the capture size limit." }));
  return { response, fields };
});
const readPages = Effect.fn("History.pages")(function* (session: Session, document: History.Document, section: History.Section, filter: "all" | "deleted", deadline: number) {
  const pages: typeof History.Page.Type[] = [];
  const seen = new Set<string>();
  let documentBytes = Buffer.byteLength(JSON.stringify(document));
  let total: number | null = null; let captured = 0; let error: string | null = null;
  for (let count = 0; count < pageLimit; count++) {
    if (Date.now() >= deadline) { error = "History collection reached its three-minute limit."; break; }
    const query = new URLSearchParams({ type: String(sections.indexOf(section)), offset: String(captured), limit: "100", search: "" });
    if (section === "friends") query.set("friendSwap", "false");
    if (section === "comments") query.set("commentFilter", filter);
    const outcome = yield* request(session, `/id/${document.steamID64}/history?${query}`).pipe(Effect.result);
    if (outcome._tag === "Failure") { error = outcome.failure.message; break; }
    const decoded = yield* Effect.try({ try: () => {
      const batch = Schema.decodeUnknownSync(Schema.fromJsonString(History.PageResponse))(outcome.success.contents);
      if (section === "comments") for (const row of batch.data) History.commentId(row);
      return batch;
    }, catch: (cause) => cause instanceof InputError ? cause : new InputError({ message: "History returned malformed history records." }) }).pipe(Effect.result);
    if (decoded._tag === "Failure") { error = decoded.failure.message; break; }
    const batch = decoded.success;
    if (total !== null && total !== batch.total) { error = "History's page total changed during collection. Refresh to retry."; break; }
    total = batch.total;
    const signature = JSON.stringify(batch.data);
    if (batch.data.length && seen.has(signature)) { error = "History repeated a history page. Refresh to retry."; break; }
    const page = { section, filter, response: outcome.success };
    const pageBytes = Buffer.byteLength(JSON.stringify(page)) + (document.pages.length + pages.length ? 1 : 0);
    if (documentBytes + pageBytes > maxBytes - 32768) {
      error = "The capture reached its 2 MB limit."; break;
    }
    documentBytes += pageBytes;
    seen.add(signature); pages.push(page); captured += batch.data.length;
    if (captured > total) { error = "History returned more rows than its declared page total."; break; }
    if (captured === total) break;
    if (!batch.data.length) { error = "History ended pagination before its declared total."; break; }
    if (count === pageLimit - 1) error = "The section reached its 100-page limit.";
  }
  return { pages, total, captured, error };
});

function summaryMismatch(section: History.Section, expected: number, captured: number): string {
  const message = `History's profile summary lists ${expected} ${section} records; this session returned ${captured}.`;
  if (section === "comments" && expected > captured)
    return message + " Deleted comments require authenticated supporter access; the summary may also be outdated.";
  return message;
}

/** One browser session owns profile and pagination. Partial sections never masquerade as empty data. */
export const fetchAccount = Effect.fn("History.fetchAccount")(function* (id: SteamId, open: OpenSession) {
  const session = yield* open(id);
  const summary = yield* profile(session, id);
  let document: History.Document = { type: "SteamHistoryCapture", steamID64: id, capturedAt: new Date().toISOString(),
    profile: summary.response, pages: [], coverage: [] };
  const counts = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Number))(summary.fields.totalHistoricCounts);
  const deadline = Date.now() + 180000;
  for (const section of sections) {
    const fetched = yield* readPages(session, document, section, "all", deadline);
    let pages = fetched.pages; let captured = fetched.captured; let total = fetched.total; let error = fetched.error;
    if (section === "comments" && !error) {
      const deleted = yield* readPages(session, { ...document, pages: [...document.pages, ...pages] }, section, "deleted", deadline);
      pages = [...pages, ...deleted.pages]; error = deleted.error;
      // Identified comments may appear in both All and Deleted. Preserve both versions, count once.
      const seen = new Set<string>(); captured = 0;
      for (const page of pages) {
        const records = Schema.decodeUnknownSync(Schema.fromJsonString(History.PageResponse))(page.response.contents).data;
        for (const row of records) {
          const identifier = History.commentId(row);
          if (identifier !== null) {
            if (seen.has(identifier)) continue; seen.add(identifier);
          }
          captured++;
        }
      }
      // The All endpoint defines the total; deleted-only additions extend that returned scope.
      total = error ? total : Math.max(total ?? 0, captured);
    }
    const expected = counts._tag === "Success" ? counts.success[section] ?? null : null;
    if (!error && expected !== null && expected !== captured) error = summaryMismatch(section, expected, captured);
    const coverage: History.Coverage = { section, captured, total, expected, status: error ? captured ? "partial" : "unavailable" : "complete",
      error: error ? `${section}: ${error}` : null };
    document = { ...document, pages: [...document.pages, ...pages], coverage: [...document.coverage, coverage] };
  }
  return yield* History.parse(JSON.stringify(document));
}, (effect) => effect.pipe(Effect.scoped));
