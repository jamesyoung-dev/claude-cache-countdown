---
name: bump-version
description: Bump the cache-countdown plugin version and move the Unreleased CHANGELOG entries under it. Use when the user asks to bump, release or cut a version of cache-countdown, or asks whether a version bump is needed.
---

# Bump the cache-countdown version

The release version lives in one place: `version` in `cache-countdown/.claude-plugin/plugin.json`. `CHANGELOG.md` records each release under that same version. Installed copies only update when the version changes, so a change that ships without a bump never reaches existing users.

Make every file edit with `Edit` or `Write`, not with `sed`, `echo` or other shell redirection, so the diff stays visible.

## 1. Check there is something to release

- Read the `## Unreleased` section of `CHANGELOG.md`. If it has no entries, stop and tell the user there is nothing to release.
- Find the last commit that touched the manifest with `git log -1 --format=%h -- cache-countdown/.claude-plugin/plugin.json`, then review `git log --oneline <that-commit>..HEAD` to confirm the Unreleased entries match the commits since.
- The repo has no git tags. Don't create one unless the user asks.

## 2. Pick the new version

The current version is in `plugin.json`. The project uses semantic versioning:

- **Patch** (for example `0.1.1` to `0.1.2`): only `### Fixed` entries.
- **Minor** (for example `0.1.1` to `0.2.0`): any `### Added` entry, or a `### Changed` or `### Removed` entry that alters behavior users rely on. While the major version is `0`, a breaking change is a minor bump.
- **Major** (`1.0.0` and up): breaking changes once the project is stable. Don't take this step without asking the user.

If the entries don't make the level clear, ask the user which one to use.

## 3. Update the two files

1. `cache-countdown/.claude-plugin/plugin.json`: change the `version` value and nothing else.
2. `CHANGELOG.md`: replace the `## Unreleased` heading with `## <new-version> - <YYYY-MM-DD>` using today's date, and keep its entries unchanged below it. Don't leave an empty `## Unreleased` heading behind. The file had none after 0.1.1, and a new one is added when the next change lands.

Afterwards, confirm the version in `plugin.json` matches the heading you wrote in `CHANGELOG.md`.

## 4. Verify

- `claude plugin validate .` checks the marketplace.
- `claude plugin validate cache-countdown` checks the manifest against the installed engine. If the engine skips the hooks, that is expected and not a failure.
- `claude plugin test ./cache-countdown` runs the test suite. Run it too, since CI runs it on every change.

Report each result as it came back. If one fails, stop and say so instead of continuing to commit.

Don't touch `typecheck/types/`, the supported-version lines, or the README's Problem section. A version bump doesn't change them.

## 5. Commit and open the PR

Commit the bump, push the branch and open the PR in the same turn. Then:

1. Never commit to `main`. Create a branch with a descriptive kebab-case name, such as `release-0-1-2`.
2. Commit with the subject `Bump cache-countdown to <new-version>`, following the earlier bump commit `8c49e2e`. Give a short body explaining what the release contains, and add the `Co-Authored-By` trailer that the session specifies.
3. Push the branch and open a pull request against `main` with `gh pr create --base main`.
4. Report the PR URL.

## Why each step is there

- The `plugin.json` version is the only signal installed copies use to decide whether to update, which is why the bump is not optional for a release.
- The CHANGELOG heading and the manifest version must match. The CHANGELOG header says it follows the version in `plugin.json`.
