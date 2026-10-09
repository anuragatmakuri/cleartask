# Local data migration and recovery

Nothing is automatically copied from Firebase or the iOS app. These are
owner-run utilities for a separately approved migration. Tests use synthetic data.

## Back up and restore local MCP data

```sh
node src/cli.js export --db /private/tasks.sqlite --output /private/tasks-backup.json
node src/cli.js backup --db /private/tasks.sqlite --output /private/tasks-backup.sqlite
```

Both refuse to overwrite existing files and use owner-only permissions.
JSON includes entity metadata, state, and audit evidence. It deliberately does
not transfer live pending approvals or retry keys. A SQLite backup preserves
the whole local database, including those records; expired plans still fail.

To recover, retain the old database and launch a separate copy of the SQLite
backup with `serve --db /private/recovered.sqlite`. Or validate/import JSON into
a new empty database:

```sh
node src/cli.js import /private/tasks-backup.json --db /private/new.sqlite
node src/cli.js import /private/tasks-backup.json --db /private/new.sqlite --confirm
```

The first invocation is a validation-only dry-run: it does not create or write
the destination. The second requires an empty destination. Imported audit
entries are marked as source evidence, not local actions. Original files are
never changed. No merge/overwrite import exists.

## Prepared Firebase export conversion

Do not export an entire multi-user database into a public repository.
Prepare a single-owner JSON file using an authorized export process outside
this package. No Firebase login or export operation is implemented here.

Expected input:

```json
{
  "format": "cleartask-firestore-export",
  "userId": "OWNER_ID",
  "spaces": [],
  "projects": [],
  "tasks": [
    {
      "id": "task-1",
      "userId": "OWNER_ID",
      "title": "Synthetic example",
      "createdAt": "2026-10-07T09:00:00-05:00",
      "reminders": []
    }
  ]
}
```

Every record needs its ID, owner ID, and creation timestamp. Project and space
records also need their name. IDs must contain only letters, numbers,
underscores, periods, or hyphens. Dates may be offset ISO strings or Firestore
`{seconds, nanoseconds}` / `{_seconds, _nanoseconds}` timestamp objects.
Mixed or missing ownership, ambiguous dates, duplicates, unsupported top-level
collections, orphan subtasks, and conflicting scope references are refused.

```sh
node src/cli.js convert-firestore /private/prepared.json --output /private/converted.json
node src/cli.js import /private/converted.json --db /private/new.sqlite
```

Conversion strips the record's top-level `userId`, normalizes timestamps, and
preserves supported entity data and extra behavioral metadata. Missing child
scope fields inherit from its parent; explicit conflicts are reported, not
silently rewritten. No destination database is changed by conversion.
Only run a confirmed import after reviewing the converted file and dry-run.

## Things this cannot recover from Firebase

The app's active focus state, focus analytics, and review session state live on
the device and are not included in a prepared task/project/space export.
Comments, labels, queue entries, app preferences, push registrations, and legacy
event logs are not part of this converter's format. Do not assume they have been
migrated. A broader export requires separately scoped mapping and tests.

Metadata about recurrence/reminders is retained when supplied; this package
does not run reminder delivery or create recurring instances.

## Audit conflicts before a real migration

The app uses top-level owner-tagged Firestore collections while some legacy
Cloud Functions expect user subcollections. The converter accepts only the
explicit prepared format; it never guesses which live collection is authoritative.
Old docs describe hard task deletion, but local MCP uses approved recoverable
family deletion. Existing Firebase behavior is unchanged.

Never delete the app, its data, or its original backup merely because a dry-run
succeeded. Check record counts, parent/project/space relationships, timestamps,
completed/deleted state, reminders, and representative task histories first.
