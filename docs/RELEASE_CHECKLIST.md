# Open-source release checklist

## Scope and permissions
- [x] User approved a public source and npm release and confirmed ownership of
  the standalone MCP package source.
- [x] The package manifest and license apply MIT to this package only; the
  existing app remains outside this license.
- [x] The user-selected destination is the public GitHub repository
  `anuragatmakuri/cleartask`, which currently contains only its initial MIT
  license commit.
- [ ] Add only this package to that repository; never push the parent app's
  history.
- [x] GitHub private vulnerability reporting is the selected channel; enable it
  in repository settings before announcing the release.
- [ ] Confirm `@cleartask/mcp` is still available and that the publisher
  controls the `@cleartask` npm scope. Direct npmjs lookup returned HTTP 404
  during preflight (no public package was found); this does not reserve the name
  or grant scope permission.

## Source and dependencies
- [x] Review the package allowlist and run `npm pack --dry-run` from
  `packages/cleartask-mcp` (not the monorepo root).
- [x] Confirm the package tarball excludes `.env`, Firebase files, SQLite/exports,
  uploads, screenshots, app configuration, personal data, development archives,
  tests, scripts, and installed dependencies.
- [x] Run redacted secret-pattern checks across current source and all available
  git history: no matches across 1,629 history text blobs; no private paths or
  targeted credential patterns were flagged.
- [x] The owner confirmed the release boundary is the standalone MCP package,
  not the iOS app or parent repository. The package source and npm tarball
  allowlist were reviewed; the parent history will not be pushed.
- [ ] Pattern checks are not a complete privacy review. The owner should inspect
  the archive before pushing and rotate any real credential exposure at its
  provider before release.
- [x] Run package checks/tests and app-source parity checks in the original
  workspace after the MCP Cleanup and Weekly Review port: 35 passed.
- [x] Generate and review the standalone lockfile and dependency notices:
  104 locked runtime packages; every notice row matches the lock.
- [x] Run fresh standalone `npm ci` against npmjs with an empty cache on Node
  22.22.0, then checks and tests: 31 passed; 4 app-source parity tests skipped
  because the legacy app is deliberately absent.
- [x] Run `npm audit --omit=dev` against npmjs after the clean install:
  0 reported vulnerabilities at preflight time.
- [ ] Enable GitHub private vulnerability reporting in the approved repository
  settings before announcing or publishing the release. `SECURITY.md` describes
  the exact setting; until enabled, no private report form exists.

## Accurate claims
- [x] README and security documentation say local storage is unencrypted and
  explain that cloud assistants may process task contents.
- [x] Documentation does not promise scheduled reminders, automatic
  recurrence, internal AI, multi-user hosting, or tamper-proof audit logs.
- [x] ChatGPT is documented as unconfigured and unverified; local tests are not
  represented as ChatGPT verification.
- [x] The user confirmed the MCP should use a separate local SQLite store; docs
  state that it does not sync with the iOS app's data.
- [x] Active deterministic Cleanup rules/actions, Weekly Review task/project
  decisions, and local review diagnostics are ported and covered by app-source
  parity or domain tests.
- [x] Standalone clean registry installation is separately verified above; the
  four app-source parity skips after extraction are disclosed.
- [x] Preserve explicit user consent before endpoints, credentials, data
  migration, app retirement, or public publishing.

## Preflight status

The owner approved public release, confirmed source ownership, and selected the
destination repository. The MCP source has not been pushed, the private
reporting setting has not been enabled, and npm scope access has not been
verified. Pattern checks do not prove that every secret or private record has
been found. Publication and user-data migration are not performed by this
preparation.
