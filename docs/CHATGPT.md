# ChatGPT connection status

The selected first milestone is local tools, not exposing a server. ChatGPT
Plus was the original client target; the current trial target is Claude Desktop
using local stdio. Claude Desktop was manually smoke-tested on macOS with
synthetic local data. ChatGPT remains unconfigured and unverified. Developer
Mode/custom MCP visibility in ChatGPT does not by itself establish write-action
access. OpenAI's current Help Center and Developer Mode guide describe
different rollout availability, so verify write actions in the actual account
before revisiting ChatGPT.

## What is verified

The official MCP SDK client discovers and calls ClearTask tools over stdio.
Tests cover CRUD, refusals, local approval, and restart with no provider keys.
This is protocol verification—not ChatGPT verification.

## What remains before connecting ChatGPT

1. Confirm that the account can create a custom MCP app with write actions;
   seeing Developer Mode or read-only MCP tools is not enough. If the account
   exposes only read tools, do not connect this write-capable package.
2. Choose and approve connectivity. ChatGPT does not directly reach a local
   stdio process on your computer.
3. A supported Secure MCP Tunnel can keep the server private, but requires
   eligibility, platform permissions, and a tunnel runtime credential.
   That credential is not an inference API key, but is still a secret.
4. Alternatively, an authenticated reachable HTTPS server needs a separately
   designed authorization boundary. This package has no HTTP transport enabled.
5. Test discovery, a read, a safe write, a rejected unapproved deletion, an
   owner-approved deletion, and connection/authorization failure cases.

Do not disable the CLI approval gate to make the connection easier.
No remote endpoint or tunnel has been provisioned, no credentials requested,
and no subscription has been changed. The Claude Desktop local trial does not
establish ChatGPT or remote-connector compatibility.

## Official references

- [Custom MCP servers](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Secure MCP tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [MCP authorization specification](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization)

Use the current account UI and documentation at connection time. Documentation
may describe different plan/rollout stages; this package does not promise
ChatGPT Plus access, public plugin submission, or a particular account feature.
