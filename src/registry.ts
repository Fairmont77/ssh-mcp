import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

export interface Host {
  name: string;
  host: string;
  user: string;
  port?: number;
  /** Absolute path to private key. ~ is expanded. */
  key?: string;
  /** Free-text purpose label. */
  note?: string;
}

const REGISTRY_PATH = join(homedir(), ".ssh", "ssh_mcp_hosts.json");

function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function load(): Host[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Host[];
  } catch {
    return [];
  }
}

function save(hosts: Host[]): void {
  const dir = join(homedir(), ".ssh");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(REGISTRY_PATH, JSON.stringify(hosts, null, 2), { mode: 0o600 });
}

export function listHosts(): Host[] {
  return load();
}

export function getHost(name: string): Host | undefined {
  const h = load().find((x) => x.name === name);
  if (h?.key) h.key = expandTilde(h.key);
  return h;
}

/** Add or overwrite a host by name. Returns the saved host. */
export function addHost(h: Host): Host {
  const hosts = load().filter((x) => x.name !== h.name);
  hosts.push(h);
  save(hosts);
  return h;
}

/** Returns true if a host was removed. */
export function removeHost(name: string): boolean {
  const hosts = load();
  const next = hosts.filter((x) => x.name !== name);
  if (next.length === hosts.length) return false;
  save(next);
  return true;
}

export { REGISTRY_PATH };
