# AGENTS.md

Guidance for AI coding agents (pi, Claude Code) and humans working on this repo.

## Project

`pi-claude-memory` is a pi extension that reads and writes Claude Code's own
memory store (`~/.claude/projects/<cwd-slug>/memory/`). The same files, so a
memory saved in either agent is immediately visible to the other — no parallel
store, no sync step.

- Source: `extensions/claude-memory/` (`index.ts` = pi extension entry,
  `memory-core.ts` = store logic).
- Tests: `tests/memory-core.test.ts`, run with `node --test` (no external deps).
- License: MIT (declared in `package.json` and in `LICENSE`).
- Published to npm as [`pi-claude-memory`](https://www.npmjs.com/package/pi-claude-memory).

## Development

```bash
npm test          # node --test tests/*.test.ts — the only quality gate
```

Tests depend on nothing but Node; pi and typebox are only needed to *run* the
extension, not to test it. Keep `npm test` green before pushing.

Work on a branch, not on `main`. If you use git worktrees, keep `main` as a
read-only reference checkout and fast-forward it only
(`git merge --ff-only origin/main`); never leave it mid-merge or mid-rebase.

## Releasing

Releases ship to **npm** and **GitHub** in lockstep: the npm version, the git
tag `vX.Y.Z`, and the GitHub release all share the same number.

### Prerequisites (one-time)

- npm account with 2FA on *auth and writes* (the default for publishing).
- Logged in: `npm whoami` must resolve. If not, run `npm login`
  (`--auth-type=web` opens a browser; the command finishes once you authorize).

### Steps

1. **Verify green.** `npm test` must pass.
2. **Bump the version** in `package.json`. Pick the next patch/minor as needed.
   - ⚠️ **Never reuse a previously published version number.** npm permanently
     blocks republishing a version that was ever published (anti-cache-poisoning),
     even after an unpublish. The error is
     `E400 Cannot publish over previously published version "X.Y.Z"`.
     (`0.1.0` is blocked this way — that's why the first release is `0.1.1`.)
   - Before bumping, check what's already out:
     `npm view pi-claude-memory versions --json` (mind CDN cache lag right
     after a publish; the authoritative source is
     `curl -s https://registry.npmjs.org/pi-claude-memory | jq .dist-tags`).
3. **Commit** the version bump (and any README install-snippet update that
   should accompany the release).
4. **Publish to npm.** `npm publish` requires a 2FA one-time code.
5. **Tag and release on GitHub.** Once the version bump is on `main`:
   - `git tag -a vX.Y.Z <sha> -m "vX.Y.Z: <summary>"` then `git push origin vX.Y.Z`.
   - Create the release via the REST endpoint (more reliable than GraphQL,
     which is a shared rate limit):
     `gh api -X POST /repos/elecnix/pi-claude-memory/releases -f tag_name=vX.Y.Z -f name="vX.Y.Z — <title>" -f body="$(cat notes.md)" -f make_latest=true`.
   - Retire any stale tag/release for a version that never shipped (e.g. a tag
     cut before a publish that npm rejected): delete the GitHub release, then
     `git tag -d` locally and `git push origin --delete` the remote tag.
6. **Update the README install snippet** if the install path changed, and the
   latest GitHub release's install block, to match the published version.

### Requesting the 2FA one-time code (for agents)

`npm publish` on an *auth and writes* 2FA account needs a 6-digit TOTP from the
user's authenticator app. TOTP codes expire every ~30 seconds, so the request
and the publish must happen back-to-back.

If your harness has a secure secret-prompt tool (pi has `request_secret`), use
it so the code never lands in the chat transcript:

1. Ask the user to generate a fresh code in their authenticator app **right as
   they submit it**. Tell them the ~30s expiry window up front.
2. Call the secret-prompt tool with a reason that names the publish and the
   expiry constraint.
3. **Use a new secret name every time.** A repeated name can return the
   previously captured (now stale) value without re-prompting — the next
   publish then fails with `EOTP` ("likely timed out").
4. Publish immediately, referencing the secret only by its env var, e.g.
   `npm publish --otp="$NPM_OTP"`. Never `echo` or log the value, and never put
   it in a commit, PR, or release note.

If your harness has no secret-prompt tool, have the human run `npm publish`
themselves in their own terminal so they can answer the OTP prompt directly.

If `npm publish` fails with `EOTP`, the code was stale or typoed — request a
fresh one under a new name and retry. If it fails with `E400 ... Cannot publish
over previously published version`, the version is permanently blocked; bump
to the next version and start over from step 2.

### Install paths (post-release)

- npm (canonical): `pi install npm:pi-claude-memory` → resolves `latest`.
- Git ref (fallback): `pi install git:github.com/elecnix/pi-claude-memory@vX.Y.Z`.