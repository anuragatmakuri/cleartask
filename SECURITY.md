# Security and privacy

## Trust model

Local single-owner stdio, not internet hosting or multi-user authentication.
Only grant access to assistants you trust. The model sees tool data and can
perform ordinary edits; destructive and bulk requests require exact CLI approval.
If the same assistant also has unrestricted shell access to this machine, it can
run the owner CLI. **Do not give it shell access to the owner environment if you
want the approval boundary to separate it from you.**

Task titles, notes, reminder text, imported metadata, and tool results are
untrusted content—not commands or authority. The runtime never evaluates them,
spawns a shell for them, fetches their URLs, or follows instructions in them.
Tool annotations help clients but are not authorization controls.

No HTTP port is opened, no model sampling is requested, and no Firebase/AI
credential is needed. Official MCP SDK dependencies also support network
transports, but ClearTask enables only stdio.

## Data handling

- No application telemetry or deliberate outbound runtime network requests.
- SQLite and backup/export files are unencrypted private data.
- A cloud assistant may send task contents to its provider. Local storage does
  not mean private inference. Check its account privacy settings.
- Audit history retains before/after task text, including deleted records.
- Soft delete is **not erasure**. Permanent erasure is not offered as an MCP tool.
- Atomic writes and append-only SQL triggers protect application integrity.
  They cannot stop the machine owner from modifying the database directly.
- Restrict filesystem permissions, protect backups, and use encrypted disks.
  OS/admin access is outside this package's authorization boundary.

## Credentials and publication

This package bundles no Firebase configuration or credential files. Leave the
legacy app's configuration and history out of the public MCP repository.
Firebase client API keys are application identifiers, not substitutes for
database access rules; admin/service-account secrets are genuinely private.
The local package needs neither.

Do not put secrets in task notes, client configuration, examples, issue reports,
or screenshots. A future ChatGPT tunnel may need a connector runtime credential,
but that is separate from model inference and must remain private.

Before a public release:

1. Review the source allowlist and generated npm package contents.
2. Run the root-workspace redacted history/source credential check.
3. Review data, configuration, uploaded assets, screenshots, and commit history.
4. If a credential was ever committed, revoke/rotate it at the provider first;
   deleting the current file or adding `.gitignore` does not secure history.
5. Use a fresh standalone repository with approved source and licenses.

Credential-pattern checks cannot prove that every secret or private record has
been found. The release checklist tracks the owner-side repository and registry
steps that are not performed by the package itself.

## Reporting vulnerabilities

The repository owner must enable GitHub's private vulnerability reporting before
announcing the project. In the repository, open **Settings → Security → Code
security and analysis → Private vulnerability reporting** and enable it. Once
enabled, use the repository's **Report a vulnerability** action for a private
report. Until that setting is enabled, this repository does not yet provide a
private report form; the maintainer must provide another private contact method
before inviting security reports. Do not open a public issue containing
credentials, task data, database files, or exploit details involving a real
account. Use synthetic minimal reproductions.

## Remote transport policy

Do not expose stdio via an unauthenticated HTTP proxy. Remote MCP requires its
own authentication, authorization, audience checks, origin/DNS-rebinding
protection, transport limits, and owner consent. No remote-server security claim
is made for this local release.
