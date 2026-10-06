# release runbook

This runbook covers a source release of the current Vapora app on GitHub. The package is private; there is no npm publishing step or current installer packaging workflow.

## release candidate

The next candidate is **2.0.0**, matching `package.json` and the lockfile. Use the existing tag convention without a `v` prefix. The last published version is `1.0.2`, the legacy Python app. Release notes are in [releases/2.0.0.md](releases/2.0.0.md).

Publish only after the proposed tag and notes have explicit approval. Merge reviewed documentation into main before choosing the release commit. Do not tag an uncommitted working copy.

## prepare

1. Run `jj status` and preserve unrelated changes. Use a clean working copy based on main.
2. Fetch main with `jj git fetch --remote origin --branch main`.
3. Record the exact main commit:

   ```sh
   jj log -r 'main@origin' --no-graph -T 'commit_id ++ "\n"'
   ```

4. Check that package and lockfile versions agree:

   ```sh
   node --input-type=module -e 'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json")); const l=JSON.parse(fs.readFileSync("package-lock.json")); if(p.version!==l.version || p.version!==l.packages[""].version) throw new Error("Version mismatch"); console.log(p.version);'
   ```

5. Confirm that the intended tag does not already exist locally or remotely. Never move an existing release tag.

   ```sh
   git tag --list 2.0.0
   git ls-remote --tags origin refs/tags/2.0.0
   gh release list --repo Microck/vapora
   ```

6. Read the final notes and README against the current commands, defaults and verification evidence. Preserve historical branches and the old release.

## verify the source download

Use a disposable directory. Export only the candidate's tracked files; exclude `.env`, installed dependencies, build outputs and local run data. Include the lockfile, assets, desktop scripts, tests and vendored lint-plugin license.

For a committed candidate, create an archive from its exact commit:

```sh
VAPORA_RELEASE_COMMIT=REPLACE_WITH_REVIEWED_MAIN_COMMIT

git archive --format=tar.gz --prefix=vapora-2.0.0/ \
  --output=/tmp/vapora-2.0.0-source.tar.gz "$VAPORA_RELEASE_COMMIT"
```

Extract it into a fresh directory and run:

```sh
npm ci
npm run verify
VAPORA_BROWSER=/path/to/chrome npm run test:e2e
npm start -- --help
```

An installed Chrome/Chromium executable is required for browser E2E. Do not weaken or skip failed checks. Confirm the archive contains no API key or local `.env` file.

## verify user workflows

- Start the browser with `npm start -- serve --root /path/to/fresh-data`. Check the printed loopback address, API-key entry, target lookup, settings, Results and Exports before selecting a run.
- Use the local provider fixtures for cancellation, restart/resume, denied keys, private profiles, provider errors, history and real downloads. Record fixture evidence separately from live Steam evidence.
- If provider behavior changed, run an authorized live scan with depth 1 and a five-account cap. Inspect names/avatars, coverage, exports and the absence of API keys in saved artifacts. Do not reuse old sample data as live proof.
- If desktop behavior or dependencies changed, check native launch, active-scan close/checkpoint/restart/resume, window controls and output folders on each supported platform. Core CI is not proof of native desktop behavior.
- Check screenshots against the current app, and update captures when visible behavior changes. Use fixture identities for public screenshots.

Current evidence is in [e2e-verification.md](e2e-verification.md). Linux and macOS native workflows passed. Native Windows launch and packaged installers are unverified, and the source-release notes must retain that limit until they are checked. Windows requires the matching Visual C++ runtime; a missing `VCRUNTIME140.dll` blocked the last VM check.

Do not present generated source archives as installers. A future installer release requires a packaging workflow and checks using the actual produced installers.

## publish

Proceed only after explicit approval of the tag and notes, all findings are resolved, and CI is green on the exact release commit.

1. Confirm the remote main commit still equals `VAPORA_RELEASE_COMMIT`. If it changed, review and verify the new candidate rather than silently tagging a different commit.
2. Confirm commit/tag identity is `Microck <contact@micr.dev>`.
3. Create an annotated tag at the pinned commit. Git is used here because Jujutsu does not create annotated tags:

   ```sh
   git -c user.name=Microck -c user.email=contact@micr.dev tag -a 2.0.0 \
     "$VAPORA_RELEASE_COMMIT" -F docs/releases/2.0.0.md
   git push origin refs/tags/2.0.0
   ```

4. Publish a normal GitHub release using the same notes:

   ```sh
   gh release create 2.0.0 --repo Microck/vapora --verify-tag \
     --title 'vapora 2.0.0' --notes-file docs/releases/2.0.0.md --latest
   ```

   GitHub provides the source ZIP and tar.gz for the tag. Do not publish an npm package, attach the legacy executable to this release, or mark it as a prerelease.

## verify after publishing

1. Confirm the release is published, not a draft, and points to the intended tag:

   ```sh
   gh release view 2.0.0 --repo Microck/vapora \
     --json url,tagName,isDraft,isPrerelease,publishedAt,assets
   git ls-remote --tags origin refs/tags/2.0.0 'refs/tags/2.0.0^{}'
   ```

2. Verify the annotated tag's peeled commit equals `VAPORA_RELEASE_COMMIT`.
3. Download a public source archive for the tag into a fresh directory. Repeat the source checks above against the actual public download.
4. Watch the CI run triggered by the tag until it passes. Report a failed or incomplete run honestly.
5. Verify main and the historical `legacy`, `feature/gui-and-analysis` and `rewrite/typescript-effect` branches remain at their expected commits.
6. Report the release URL, tagged commit, completed checks and outstanding platform limits.

## recover from a publishing problem

- If a tag push or release creation fails, inspect remote tag and release state before retrying. A pushed tag with no release can use the same verified tag when creating the release.
- If an incorrect release is already public, leave its tag fixed. Record the problem, correct the app or documentation, and publish a new patch version after review and approval.
- If storage failed during an app run, fix disk space or permissions. Resume incomplete scans; use `npm start -- analyze RUN_ID --root DIRECTORY` to regenerate exports from a saved checkpoint.
