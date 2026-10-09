# Claude Desktop local setup

ClearTask's supported transport is local MCP over stdio. Claude Desktop can
start this process on the computer where Claude Desktop and the ClearTask
database run. This is different from Claude's remote custom connectors, which
connect from Anthropic's cloud and require a publicly reachable server.

## Copy the package from Replit

In Replit's file tree, open `packages`, use the three-dot menu next to
`cleartask-mcp`, and choose **Download as zip**. Extract the ZIP on your Mac.
This package contains the MCP source and its lockfile, not your app data,
Firebase credentials, or local SQLite database.

## Requirements

- Claude Desktop on macOS.
- The `packages/cleartask-mcp` source copied to your Mac. It is not currently
  published to npm.
- Node.js 22.13 or later and npm on that Mac. The server uses `node:sqlite`.

Copy only this package, including both `package.json` and
`package-lock.json`. It does not need the Expo app, Firebase configuration, or
app credentials. If you copied the full ClearTask repository, first enter the
MCP package directory; do not run these commands from the repository root:

```sh
cd packages/cleartask-mcp
ls package.json package-lock.json
npm ci
npm test
node src/cli.js help
```

If you copied just the package folder, run the commands inside that folder
instead. `package-lock.json` must be beside `package.json`; if `ls` reports it
is missing, copy the complete MCP package folder again from Replit.

## Add the local server to Claude Desktop

1. In Claude Desktop, open **Settings → Developer → Edit Config**.
2. Add the `cleartask` entry below under `mcpServers`. Merge it into the
   existing JSON instead of replacing other server entries.
3. Replace both example paths with absolute paths on your Mac. In Terminal,
   `which node` shows the Node executable path; use that full path for
   `command`. Set `args[0]` to the full path to this package's `src/cli.js`.
4. Save the file and restart Claude Desktop.
5. In a new chat, open **Connectors** and confirm ClearTask and its tools appear.

```json
{
  "mcpServers": {
    "cleartask": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/cleartask-mcp/src/cli.js", "serve"],
      "env": {
        "TZ": "America/Chicago"
      }
    }
  }
}
```

## Data and approvals

- The database defaults to `~/.cleartask/cleartask.sqlite` on the Mac. It is
  separate from the existing app and Firebase data; nothing syncs or migrates
  automatically.
- SQLite files and backups are not encrypted by this package. Use macOS disk
  encryption and protect backups.
- Tool requests, task text, and tool results sent to Claude are processed by
  Anthropic. Review Claude's current account privacy and model-improvement
  settings before connecting personal task data. See Anthropic's
  [consumer terms](https://www.anthropic.com/legal/consumer-terms).
- Ordinary writes are available through MCP. Delete and bulk-change plans must
  still be inspected and approved by the owner using the local CLI. MCP has no
  approval tool.
- Do not give Claude unrestricted shell or terminal access on this Mac. That
  would let it run the owner CLI and bypass the separation between assistant
  requests and local owner approval.
- The Mac and Claude Desktop must be running while the local server is used.

## Verification status

Claude Desktop on macOS was manually smoke-tested with synthetic local data:

- Connector discovery, a read, and synthetic task create/read succeeded.
- A deletion preview contained only the synthetic task. The owner inspected
  and approved that exact plan through the local CLI; applying it deleted only
  the test task.
- Claude declined an unapproved apply request before invoking the MCP tool.
  The official SDK stdio test separately confirms that the server rejects an
  unapproved apply and malformed input.

The user's Mac test run reported 28 passing tests, 2 skipped, and no failures.
This verifies the local stdio path, not ChatGPT, remote connectors, or access
to the existing Firebase-backed app data. Claude's pre-approval refusal was at
the assistant level; a server-side unapproved apply was verified by the SDK
test rather than by Claude Desktop.

Check Claude Desktop's **Settings → Developer** connection status and logs if
the server does not start.

## Official references

- [Local MCP servers in Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Remote MCP custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Anthropic consumer terms](https://www.anthropic.com/legal/consumer-terms)
