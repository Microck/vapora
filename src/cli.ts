import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { Config, Effect, Redacted, Schema } from "effect";
import { defaults, InputError, presets, Settings } from "./model.js";
import * as Storage from "./storage.js";
import * as Steam from "./steam.js";
import * as Scanner from "./scanner.js";
import * as Analysis from "./analysis.js";
import * as History from "./history.js";
import * as Server from "./server.js";

const help = `Vapora 2 | Public Steam friend networks

  vapora serve                          Open the local browser UI (default)
  vapora scan TARGET                    Scan and export a network
  vapora estimate TARGET                Sample the network without saving a run
  vapora resume RUN_ID                  Continue a saved checkpoint
  vapora analyze RUN_ID                 Rebuild reports from saved observations
  vapora recent                         List saved runs
  vapora profiles                       List saved configuration profiles
  vapora profile-save NAME              Save current options as a profile
  vapora history FILE [--run RUN_ID]     Analyze normalized SteamHistory JSON/NDJSON

Options:
  --preset inner|community   --profile NAME   --depth 1..5   --max-nodes 0..1000
  --rpm 0..120               --groups         --games       --hub-percentile 0.5..1
  --mutual-weight N          --jaccard-weight N             --group-weight N
  --game-weight N            --skip-private   --root DIRECTORY --port PORT   --help

Set STEAM_API_KEY in your environment or .env. The browser can also use a session-only key.
Zero nodes removes the account cap; zero rpm removes pacing. Retry/backoff still applies.
Run npm start -- COMMAND after npm run build. Profiles and runs stay under --root.
Scores are public network heuristics, not proof of real-life friendship or residence.
`;

export async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs({ args, allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, preset: { type: "string" }, profile: { type: "string" },
    depth: { type: "string" }, "max-nodes": { type: "string" }, rpm: { type: "string" },
    groups: { type: "boolean" }, games: { type: "boolean" }, "hub-percentile": { type: "string" },
    "skip-private": { type: "boolean" },
    "mutual-weight": { type: "string" }, "jaccard-weight": { type: "string" }, "group-weight": { type: "string" }, "game-weight": { type: "string" },
    root: { type: "string" }, port: { type: "string" }, run: { type: "string" },
  } });
  if (parsed.values.help) { stdout.write(help); return; }
  let command = parsed.positionals[0] ?? "serve";
  let argument = parsed.positionals[1];
  if (!args.length && stdin.isTTY) {
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      const choice = await readline.question("Vapora: [Enter] browser UI, or type scan / estimate / recent: ");
      command = choice.trim() || "serve";
      if (["scan", "estimate"].includes(command)) argument = await readline.question("Steam profile URL or ID: ");
    } finally { readline.close(); }
  }
  const root = parsed.values.root ?? process.cwd();
  const key = Redacted.value(await Effect.runPromise(Config.Redacted("STEAM_API_KEY").pipe(Config.withDefault(Redacted.make("")))));
  if (command === "serve") {
    const port = Schema.decodeUnknownSync(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })))(Number(parsed.values.port ?? 3000));
    const server = await Server.start({ root, key, port });
    stdout.write(`Vapora is ready at ${server.origin}\nPress Ctrl+C to stop. Active scans save their checkpoint.\n`);
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      void server.close().catch((error) => { console.error(error); process.exitCode = 1; });
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    return;
  }
  const settingsFor = Effect.fn("Cli.settings")(function* () {
    const store = yield* Storage.Service;
    let settings = defaults;
    if (parsed.values.preset) {
      if (parsed.values.preset !== "inner" && parsed.values.preset !== "community") return yield* Effect.fail(new InputError({ message: "Choose preset inner or community." }));
      settings = presets[parsed.values.preset];
    }
    if (parsed.values.profile) settings = yield* store.profile(parsed.values.profile);
    const values = parsed.values;
    settings = yield* Schema.decodeUnknownEffect(Settings)({
      ...settings,
      depth: values.depth === undefined ? settings.depth : Number(values.depth),
      maxNodes: values["max-nodes"] === undefined ? settings.maxNodes : Number(values["max-nodes"]),
      requestsPerMinute: values.rpm === undefined ? settings.requestsPerMinute : Number(values.rpm),
      includeGroups: values.groups ?? settings.includeGroups, includeGames: values.games ?? settings.includeGames,
      skipPrivate: values["skip-private"] ?? settings.skipPrivate,
      hubPercentile: values["hub-percentile"] === undefined ? settings.hubPercentile : Number(values["hub-percentile"]),
      weights: {
        mutual: values["mutual-weight"] === undefined ? settings.weights.mutual : Number(values["mutual-weight"]),
        jaccard: values["jaccard-weight"] === undefined ? settings.weights.jaccard : Number(values["jaccard-weight"]),
        groups: values["group-weight"] === undefined ? settings.weights.groups : Number(values["group-weight"]),
        games: values["game-weight"] === undefined ? settings.weights.games : Number(values["game-weight"]),
      },
    }).pipe(Effect.mapError(() => new InputError({ message: "Invalid settings. Run --help for accepted ranges." })));
    return settings;
  });
  const program = Effect.gen(function* () {
    const store = yield* Storage.Service;
    if (command === "recent") {
      const recent = yield* store.recent();
      for (const scan of recent.runs) stdout.write(`${scan.id}\t${scan.status}\t${scan.seed}\t${scan.players.length} nodes\n`);
      for (const issue of recent.issues) stdout.write(`${issue.id}\tinvalid\t${issue.message}\n`);
      return;
    }
    if (command === "profiles") { stdout.write(`${(yield* store.profiles()).join("\n")}\n`); return; }
    if (!["scan", "estimate", "resume", "analyze", "profile-save", "history"].includes(command)) return yield* Effect.fail(new InputError({ message: `Unknown command: ${command}. Run --help.` }));
    if (!argument) return yield* Effect.fail(new InputError({ message: `${command} requires ${command === "history" ? "a file" : command === "resume" || command === "analyze" ? "a run ID" : "a target or profile name"}. Run --help.` }));
    if (command === "analyze") {
      const scan = yield* store.read(argument);
      const report = yield* Analysis.exportRun(scan);
      stdout.write(`${report.coverage.nodes} nodes analyzed. Exports: ${root}/outputs/${scan.id}\n`); return;
    }
    if (command === "history") {
      const contents = yield* Effect.tryPromise({ try: () => readFile(argument, "utf8"), catch: () => new InputError({ message: "Could not read the history file." }) });
      const report = yield* History.parse(contents).pipe(Effect.flatMap(History.analyze));
      if (parsed.values.run) {
        const scan = yield* store.read(parsed.values.run);
        if (scan.seed !== report.profile.steamID64) return yield* Effect.fail(new InputError({ message: "History belongs to another account." }));
        yield* store.writeArtifact(scan.id, "history.json", JSON.stringify(report, null, 2));
      }
      stdout.write(`${JSON.stringify(report, null, 2)}\n`); return;
    }
    const settings = yield* settingsFor();
    if (command === "profile-save") { yield* store.saveProfile(argument, settings); stdout.write(`Saved profile ${argument}\n`); return; }
    if (!key) return yield* Effect.fail(new InputError({ message: "Set STEAM_API_KEY in your environment or .env before using the CLI scanner." }));
    const live = Steam.layer({ key, requestsPerMinute: settings.requestsPerMinute });
    if (command === "estimate") {
      const estimate = yield* Scanner.estimate(argument, settings).pipe(Effect.provide(live));
      stdout.write(`${JSON.stringify(estimate, null, 2)}\n`); return;
    }
    const saved = command === "resume" ? yield* store.read(argument) : null;
    yield* Effect.gen(function* () {
      const scan = saved ?? (yield* Scanner.create(argument, settings));
      if (scan.status === "complete") { stdout.write(`Run ${scan.id} is already complete.\n`); return; }
      const completed = yield* Scanner.run(scan, (progress) => {
        if (stdout.isTTY) stdout.write(`\r${progress.phase}: ${progress.scanned}/${progress.nodes} profiles, ${progress.remaining} queued     `);
      });
      stdout.write(`\nComplete: ${root}/outputs/${completed.id}\n`);
    }).pipe(Effect.provide(Steam.layer({ key, requestsPerMinute: saved?.settings.requestsPerMinute ?? settings.requestsPerMinute })));
  });
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try { await Effect.runPromise(program.pipe(Effect.provide(Storage.layer(root))), { signal: controller.signal }); }
  finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : "Vapora failed."); process.exitCode = 1; });
}
