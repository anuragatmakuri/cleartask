# Contributing

Requires Node 22.13+ and npm. Use `npm ci`, `npm run check`, and `npm test`.
In the original workspace use the root lock and `npm run mcp:test`.

## Contracts

- The assistant reasons; ClearTask performs deterministic validated operations.
  No model SDK, inference key, sampling, or agent framework belongs in the core.
- Keep domain/storage separate from MCP transport. Never write directly from a
  tool handler outside the domain transaction.
- Keep schemas strict and responses paginated. Never accept guessed ownership,
  `approved: true`, arbitrary filesystem paths, or protected audit/counter edits.
- All writes require idempotency; existing-record edits require versions.
- Deletes/bulk writes require exact local-owner approval and reject stale plans.
- Preserve inherited subtask relationships and recoverable deletion groups.
- Emit local audit history atomically. Never rewrite historical events.
- Scoring is focus_v3. Weekly-review selection is V0 with Monday 06:00 memory.
  Time must be injected for deterministic tests. Compare app parity in the
  original workspace; update versions/contracts before changing behavior.
- Reminder repeat metadata is preserved but not executed by a scheduler.
- Schema evolution requires an explicit database migration and recovery tests.
- Never move the legacy app's data or change its behavior as a side effect.

Use synthetic fixtures. Do not commit private exports, `.env`, SQLite databases,
credentials, real task text, or screenshots from a user's account.

## Standalone source preparation

In the original workspace, `node scripts/prepare-standalone.js` regenerates the
portable package lock from the root's installed dependency closure. It removes
internal registry URLs without changing integrity hashes. This script relies on
the parent workspace and is not needed by standalone consumers.

For isolated verification, pass a new temporary path:

```sh
node scripts/prepare-standalone.js /tmp/cleartask-standalone-check
```

This copies the package and only its installed runtime dependencies, not the
app, keys, or user data. Run checks/tests in that directory. This is an isolation
test of installed dependencies, **not** a new registry installation.

Before release, perform an actual clean `npm ci` against the portable lock on a
fresh supported machine, review the release checklist, and approve publication
separately. Dependency licenses apply independently of this package's MIT grant.
