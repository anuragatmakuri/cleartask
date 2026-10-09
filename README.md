# ClearTask MCP

Deterministic task management for an AI assistant through the Model Context
Protocol. The assistant reasons; ClearTask stores, validates, and changes data.
**ClearTask does not call a model.**

## Current release boundaries

- Local-first SQLite, single owner, **stdio only**.
- A separate task store: it does not read or sync the iOS app's Firestore data.
  Existing tasks require a deliberate owner-run migration.
- Task, subtask, project, and space management; deterministic focus, active
  Cleanup suggestions and scorecards, Weekly Review decisions and project drift,
  local 7/30-day review diagnostics, durable sessions, and audit history.
- No Firebase account, model API key, network listener, telemetry, or background
  scheduler. Reminder data and repeat intervals are stored, not dispatched.
- MIT covers **this package only**, not the existing iOS app or entire repository.
- Claude Desktop local stdio was manually smoke-tested on macOS with synthetic
  data: tool discovery, read, create/read, and owner-CLI-approved deletion.
  Claude declined an unapproved apply request before invoking the tool; the
  SDK tests separately verify server-side refusal and malformed-input failure.
  ChatGPT connectivity remains unconfigured and unverified.

## Requirements

Node **22.13 or later**, with the built-in `node:sqlite` module. SQLite may print
an experimental-feature warning on stderr. Use a supported Node LTS release.
No native build toolchain is needed.

## Install from this workspace

From the repository root:

```sh
npm ci
npm run mcp:test
npm run mcp:start
```

The last command waits for a stdio MCP client; it is not a website. App workflows
and Firebase data remain separate. The npm workspace lock pins the dependencies.

## Use the standalone source

Only copy `packages/cleartask-mcp` into the new MCP repository—not the app, its
history, configuration, uploaded files, or private data. It has its own portable
`package-lock.json`:

```sh
cd cleartask-mcp
npm ci
npm test
node src/cli.js help
```

The parity tests compare to the mobile source when run in the original workspace;
they explicitly skip when the legacy app is absent. The other tests work
independently. The release-preparation script is for this original workspace,
not a requirement for standalone installation.

For a client that supports local stdio servers, use this template, replacing the
absolute paths and timezone. Claude Desktop setup notes are in
[`docs/CLAUDE.md`](docs/CLAUDE.md).

```json
{
  "mcpServers": {
    "cleartask": {
      "command": "node",
      "args": ["/absolute/path/to/cleartask-mcp/src/cli.js", "serve"],
      "env": { "TZ": "America/Chicago" }
    }
  }
}
```

This configuration is **not** a remote connector URL for ChatGPT or Claude's
web app. It starts the server on the same computer as the MCP client.

## Storage and timezone

The default database is `~/.cleartask/cleartask.sqlite`. For an explicit database:

```sh
node src/cli.js serve --db /absolute/private/path/tasks.sqlite
```

Database, JSON exports, and backups are created with owner-only file permissions
on supporting systems. They are **not encrypted**. Use OS disk encryption,
restrict access to the directory, and keep backups outside public repositories.

Timestamp input must be ISO 8601 with an explicit offset, such as
`2026-10-12T09:00:00-05:00` or a UTC `Z` suffix. Calendar-day calculations use the
process timezone. Weekly review resets Monday at 06:00 local time. Set `TZ`
consistently before starting; the default is the operating system's timezone.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_records`, `get_record` | Paginated search/read tasks, projects, spaces, and their current versions |
| `create_task`, `create_project`, `create_space` | Create records without automatic default seeding |
| `change_record` | Validated edits, completion/reopening, deferral, archive/unarchive, single-record restore |
| `preview_changes`, `apply_changes` | Exact owner-approved delete, family restore, and bulk changes |
| `get_focus` | Pure focus_v3 ranking with score breakdowns; does not start focus |
| `get_cleanup_suggestions` | Current rule-based Cleanup suggestions and detailed scorecards |
| `record_cleanup_action` | Apply a cleanup defer/complete/rewrite or persist a 7-day skip |
| `get_weekly_review` | Current overdue/upcoming/project-drift/backlog candidates, backlog count, and diagnostics |
| `get_weekly_diagnostics` | Local completion/reschedule counts and backlog trend |
| `start_review`, `record_review_decision`, `record_project_review_decision`, `finish_review` | Persist task and project review decisions and cycle memory |
| `start_focus`, `end_focus`, `get_session_state` | Explicit persistent focus sessions and review status |
| `get_audit_history` | Paginated local before/after mutation history |

`cleartask://usage` provides the operating rules as an MCP resource.

Every write needs a caller-supplied **idempotency key** of 8–160 characters.
Retrying the same request/key returns its original result instead of duplicating
the action. Reusing a key for a different request fails.

Existing-record actions require `expectedVersion` from a recent read. IDs and
versions are not guessed. Unknown edit fields, malformed dates, invalid
references, and direct subtask reassignment fail explicitly. A subtask has
exactly one top-level parent and inherits its project/space. Completion cascades
and scope changes are returned in the result.

### Example: create and edit

Call `create_task`:

```json
{
  "data": { "title": "Review the release", "important": true },
  "idempotencyKey": "release-task-create-001"
}
```

Use the returned ID and the version from `get_record` in `change_record`:

```json
{
  "operation": {
    "entity": "task",
    "action": "complete",
    "id": "REPLACE_WITH_RETURNED_ID",
    "expectedVersion": 1
  },
  "idempotencyKey": "release-task-complete-001"
}
```

`change_record` accepts `create/update/complete/reopen/defer/archive/unarchive/
restore` as appropriate to the entity; use the dedicated create tools for clearer
schemas. `defer` needs a future `until` timestamp and hides a task until then.
`delete` is recognized but **always rejected** by this direct-write tool.

### Delete and bulk approval

1. The assistant calls `preview_changes`, specifying the records and versions.
2. The owner inspects the exact before/after records locally:

   ```sh
   node src/cli.js plan PLAN_ID --db /private/path/tasks.sqlite
   ```

3. Only after checking them, the owner approves that exact digest locally:

   ```sh
   node src/cli.js approve PLAN_ID --digest EXACT_DIGEST --db /private/path/tasks.sqlite
   ```

4. The assistant calls `apply_changes` with `{ "planId": "PLAN_ID" }`.

MCP has **no approval tool**. A boolean like `approved: true` cannot authorize a
change. Plans expire after 15 minutes and fail if data changes after preview.
All requested operations commit together with history, or none do. Reapplying
the same plan safely returns its original result.

Deletion is recoverable: a parent and its live children share a deletion group.
Restoration brings back only that group, not a child deleted independently
earlier. Deleted items are available through reads and `status: "deleted"`.
Project/space deletion detaches task references; it never deletes the tasks.
Restoring a deleted container does **not** automatically reattach detached
records, which may have been moved since; make those edits explicitly.

Ordinary task `archive` means completion. Weekly-review task archive means
soft-deletion through an approved preview. Project/space archive uses
`isArchived` and can be undone with `unarchive`.

### Weekly review

Read candidates, start/resume a session, then record decisions for its candidates.
`keep` persists cycle memory. `reschedule` requires `dueDate` and changes it
atomically. Project drift actions match the active app: `project_add_task`,
`project_review`, and `project_archive`. The archive action requires explicit
confirmation; `project_add_task` records the decision and the assistant creates
the task separately if requested. To record a task `archive`, first soft-delete
the task through an owner-approved plan, then record the decision with the latest
version. Completing a session does not silently mark unreviewed tasks as reviewed.
`get_weekly_review` also returns the current open-task count and diagnostics;
`get_weekly_diagnostics` reads the same 7-day counts, 30-day weekly averages,
and snapshot-based backlog comparison shown by the app. Backlog comparisons
become meaningful after at least one completed review snapshot exists.

### AI Cleanup

`get_cleanup_suggestions` runs the active ClearTask `cleanup_v2` rules and
returns actionable candidates plus detailed scorecards. The standard suggestions
are deterministic; the current mobile screen's old OpenAI rewrite helper is
unused. A connected assistant may explain a candidate or propose a clearer title,
but the package itself does not call a model or send task data to an AI provider.
Read the candidate and task version again before acting.

`record_cleanup_action` supports the current suggestion actions: skip a candidate
for seven days, hide a task until an explicit future timestamp, complete/archive a
task, or apply an assistant-proposed title. Detailed scorecards support skip or
complete. Standard suggestions are paginated in the same first-five order as the
app; detailed scorecards are also paginated. Skips suppress standard suggestions
for that task during the cooldown; scorecards remain independently visible.
Cleanup does not permanently delete tasks. Confirm with the user before a
completion or title rewrite; use the owner-approved delete flow for deletion.

Review and focus progress survive server restarts. Focus ends only on an explicit
`end_focus` call; completing or deleting its task does not erase session history.

## Backup, import, and migration

See [migration instructions](docs/MIGRATION.md). Import defaults to dry-run and
requires an empty destination plus `--confirm` to write. Existing Firebase data
is never queried, converted, or moved automatically.

## ChatGPT

See [ChatGPT connection status](docs/CHATGPT.md). ChatGPT cannot directly connect
to this stdio process in your filesystem. Its custom MCP setup requires approved
reachable connectivity and account eligibility. No public endpoint, tunnel,
credentials, or subscription change has been configured.

## Development and release

From the original workspace root:

```sh
cd packages/cleartask-mcp
npm run check
npm test
npm pack --dry-run
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before adding
tools. The package allowlist excludes the legacy app, `.env`, databases, exports,
and uploaded assets. Runtime dependencies are the official MCP SDK and Zod;
their own licenses still apply. See the generated [dependency notices](docs/DEPENDENCIES.md).

Do not publish the parent repository wholesale. The user has approved release
of this package and confirmed source ownership. Follow
[`docs/GITHUB_RELEASE.md`](docs/GITHUB_RELEASE.md) to add only these standalone
files to the selected repository. The GitHub private vulnerability-reporting
setting and npm scope access still need owner-side confirmation. Run
`npm pack --dry-run` from this package directory, not the monorepo root.
