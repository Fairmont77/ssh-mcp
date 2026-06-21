# ssh-mcp

A small, reliable [MCP](https://modelcontextprotocol.io) server that gives an AI agent (Claude Code, etc.) persistent SSH access to your servers — register a host once, then run commands by name.

## Why

Stock SSH MCP servers reimplement the SSH transport in-process: they drop connections, lose credentials between sessions, and force the agent to fall back to raw `ssh -i key user@host` shell-outs (which leak creds into command history and break on reconnect).

This server does **not** reimplement SSH. It wraps the system `ssh`/`scp` binaries with OpenSSH **ControlMaster** multiplexing:

- A background control socket (`ControlPersist=10m`) keeps one authenticated connection warm — reconnects are instant and survive MCP restarts.
- Credentials live in a registry file (`~/.ssh/ssh_mcp_hosts.json`), set once, reused by host name.
- The agent calls `ssh_exec(host="myserver", command=...)` — no keys or IPs in every call.

## Tools

| Tool | Purpose |
|---|---|
| `host_add` | Register/overwrite a named host (name, host, user, port?, key?, note?) |
| `host_list` | List registered hosts |
| `host_remove` | Remove a host by name |
| `ssh_exec` | Run one non-interactive command on a host (one-shot) |
| `sftp_put` | Upload a local file via scp |
| `sftp_get` | Download a remote file via scp |

## Execution model — one-shot

Each `ssh_exec` is an independent command. State does **not** persist between calls:

- `cwd` does not persist → use absolute paths or `cd /path && cmd`.
- env does not persist → set inline (`VAR=x cmd`).
- No interactive TUI (`vim`, `top`, `less`) and no prompts → pass `-y`/`--yes`.
- Long jobs: `nohup cmd >/tmp/x.log 2>&1 &`, then tail the log in a later call.

## Requirements

- Node.js 23.6+ (runs TypeScript directly via type-stripping — no build step)
- OpenSSH client (`ssh`, `scp`) on PATH

## Install

```bash
pnpm install
```

Register with your MCP client (e.g. Claude Code `~/.claude.json`):

```json
{
  "mcpServers": {
    "ssh": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/ssh_mcp/src/index.ts"]
    }
  }
}
```

Restart the client, then add a host:

```
host_add(name="myserver", host="1.2.3.4", user="root", key="~/.ssh/id_ed25519")
ssh_exec(host="myserver", command="uname -a")
```

## License

MIT
