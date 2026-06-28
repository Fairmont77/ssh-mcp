#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { addHost, listHosts, getHost, removeHost, REGISTRY_PATH } from "./registry.ts";
import { sshExec, scpPut, scpGet, type ExecResult } from "./ssh.ts";
import { isAuthDenied, provisionHost, provisionHint } from "./provision.ts";

const server = new McpServer({ name: "ssh-mcp", version: "0.1.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function fmt(r: ExecResult): string {
  const parts: string[] = [];
  if (r.timedOut) parts.push("[TIMED OUT]");
  parts.push(`exit=${r.code}`);
  if (r.stdout) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
  return parts.join("\n");
}

function requireHost(name: string) {
  const h = getHost(name);
  if (!h) throw new Error(`Unknown host "${name}". Registered: ${listHosts().map((x) => x.name).join(", ") || "(none)"}. Use host_add first.`);
  return h;
}

server.registerTool(
  "host_add",
  {
    title: "Add SSH host",
    description: "Register (or overwrite) a named SSH host so future calls need only its name. Credentials persist in ~/.ssh/ssh_mcp_hosts.json.",
    inputSchema: {
      name: z.string().describe("Short alias, e.g. 'myserver'"),
      host: z.string().describe("Hostname or IP"),
      user: z.string().describe("SSH username"),
      port: z.number().int().optional().describe("SSH port (default 22)"),
      key: z.string().optional().describe("Path to private key, e.g. ~/.ssh/id_ed25519"),
      note: z.string().optional().describe("Purpose label"),
    },
  },
  async ({ name, host, user, port, key, note }) => {
    addHost({ name, host, user, port, key, note });
    return text(`Saved host "${name}" → ${user}@${host}${port ? `:${port}` : ""}${key ? ` (key ${key})` : ""}`);
  }
);

server.registerTool(
  "host_list",
  { title: "List SSH hosts", description: "List all registered SSH hosts.", inputSchema: {} },
  async () => {
    const hosts = listHosts();
    if (!hosts.length) return text(`No hosts registered. Registry: ${REGISTRY_PATH}`);
    return text(hosts.map((h) => `${h.name}: ${h.user}@${h.host}${h.port ? `:${h.port}` : ""}${h.key ? ` [${h.key}]` : ""}${h.note ? ` — ${h.note}` : ""}`).join("\n"));
  }
);

server.registerTool(
  "host_remove",
  { title: "Remove SSH host", description: "Remove a registered SSH host by name.", inputSchema: { name: z.string() } },
  async ({ name }) => text(removeHost(name) ? `Removed "${name}".` : `No host named "${name}".`)
);

server.registerTool(
  "ssh_exec",
  {
    title: "Run remote command",
    description:
      "Run ONE non-interactive command on a registered host (one-shot). State does NOT persist between calls: use absolute paths or 'cd /x && cmd'. No TUI (vim/top/less) and no prompts — pass -y and use non-interactive flags. For long jobs use nohup and tail logs separately.",
    inputSchema: {
      host: z.string().describe("Registered host name"),
      command: z.string().describe("Shell command to run on the remote"),
      timeout_ms: z.number().int().optional().describe("Kill after this many ms (default 60000)"),
      password_file: z
        .string()
        .optional()
        .describe(
          "Path to a file holding the host's login password (NEVER pass the password inline — it would be logged). Used ONCE to auto-provision a dedicated ed25519 key, then the file is wiped (overwritten + deleted). Must be a temp file, not an SSH key. Only needed the first time, when key-auth fails."
        ),
    },
  },
  async ({ host, command, timeout_ms, password_file }) => {
    const h = requireHost(host);
    const timeout = timeout_ms ?? 60000;
    let r = await sshExec(h, command, timeout);
    if (isAuthDenied(r)) {
      if (!password_file) return text(`${fmt(r)}\n\n${provisionHint(host)}`);
      const prov = await provisionHost(h, password_file);
      if (!prov.ok) return text(`Provisioning failed: ${prov.message}`);
      r = await sshExec(requireHost(host), command, timeout);
      return text(`[${prov.message}]\n${fmt(r)}`);
    }
    return text(fmt(r));
  }
);

server.registerTool(
  "sftp_put",
  {
    title: "Upload file",
    description: "Upload a local file to a registered host via scp.",
    inputSchema: { host: z.string(), local_path: z.string(), remote_path: z.string() },
  },
  async ({ host, local_path, remote_path }) => text(fmt(await scpPut(requireHost(host), local_path, remote_path)))
);

server.registerTool(
  "sftp_get",
  {
    title: "Download file",
    description: "Download a file from a registered host to a local path via scp.",
    inputSchema: { host: z.string(), remote_path: z.string(), local_path: z.string() },
  },
  async ({ host, remote_path, local_path }) => text(fmt(await scpGet(requireHost(host), remote_path, local_path)))
);

const transport = new StdioServerTransport();
await server.connect(transport);
