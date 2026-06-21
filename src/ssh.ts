import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { Host } from "./registry.ts";

const CM_DIR = join(homedir(), ".ssh", "ssh_mcp_cm");

function ensureCmDir(): void {
  if (!existsSync(CM_DIR)) mkdirSync(CM_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Shared OpenSSH options. ControlMaster keeps a background socket alive
 * (ControlPersist) so repeated calls reuse one authenticated connection —
 * survives MCP restarts, no per-call login cost.
 */
function baseOpts(h: Host): string[] {
  ensureCmDir();
  const opts = [
    "-o", "ControlMaster=auto",
    "-o", "ControlPersist=10m",
    "-o", `ControlPath=${join(CM_DIR, "%r@%h:%p")}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
  ];
  if (h.port) opts.push("-p", String(h.port));
  if (h.key) opts.push("-i", h.key);
  return opts;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** Run a single command on the remote host (one-shot, non-interactive). */
export function sshExec(h: Host, command: string, timeoutMs = 60000): Promise<ExecResult> {
  const args = [...baseOpts(h), `${h.user}@${h.host}`, "--", command];
  return run("ssh", args, timeoutMs);
}

/** Rewrite a leading "-" local path to "./-..." so scp can't parse it as a flag. */
function safeLocal(p: string): string {
  return p.startsWith("-") ? `./${p}` : p;
}

/** Upload a local file to the remote host via scp (reuses the control socket). */
export function scpPut(h: Host, localPath: string, remotePath: string, timeoutMs = 120000): Promise<ExecResult> {
  const args = [...baseOpts(h), "--", safeLocal(localPath), `${h.user}@${h.host}:${remotePath}`];
  return run("scp", args, timeoutMs);
}

/** Download a remote file to a local path via scp. */
export function scpGet(h: Host, remotePath: string, localPath: string, timeoutMs = 120000): Promise<ExecResult> {
  const args = [...baseOpts(h), "--", `${h.user}@${h.host}:${remotePath}`, safeLocal(localPath)];
  return run("scp", args, timeoutMs);
}
