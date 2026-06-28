import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, writeFileSync, statSync, unlinkSync, chmodSync } from "node:fs";
import { addHost, type Host } from "./registry.ts";
import { run, sshExec, type ExecResult } from "./ssh.ts";

/** Same conservative token as the registry: no leading "-", no spaces/@/:. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Absolute path of the dedicated private key for a host (one key per host). */
export function keyPathFor(name: string): string {
  if (!SAFE.test(name)) throw new Error(`Unsafe host name "${name}".`);
  return join(homedir(), ".ssh", `ssh_mcp_${name}_ed25519`);
}

/**
 * True when an ssh attempt failed because no usable credential was accepted
 * (so provisioning a key would help). Distinguishes auth failure from host-key
 * or connection errors, which provisioning cannot fix.
 */
export function isAuthDenied(r: ExecResult): boolean {
  if (r.timedOut || r.code !== 255) return false;
  const e = r.stderr;
  if (/Host key verification failed/i.test(e)) return false;
  return /Permission denied|Authentication failed|No more authentication methods|Too many authentication failures/i.test(e);
}

/**
 * Generate a dedicated ed25519 key for the host if it does not exist yet.
 * No passphrase (`-N ""`): the server is a non-interactive one-shot daemon that
 * cannot prompt to unlock a key, so passphrase-protected keys would break every
 * call. Threat model: the key file is 0600 in ~/.ssh and is only as safe as the
 * user's home directory. Do NOT add passphrase prompting — it deadlocks the daemon.
 */
export async function generateKey(name: string): Promise<{ priv: string; pub: string }> {
  const priv = keyPathFor(name);
  const pub = `${priv}.pub`;
  if (existsSync(priv)) return { priv, pub };
  const r = await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", priv, "-C", `ssh_mcp ${name}`], 30000);
  if (r.code !== 0) throw new Error(`ssh-keygen failed (exit ${r.code}): ${r.stderr.trim()}`);
  chmodSync(priv, 0o600); // explicit; ssh-keygen already does this, but make intent enforced
  return { priv, pub };
}

/**
 * Install the public key into the host's authorized_keys using a one-time
 * password read from a file (never argv, so it can't leak via `ps`). The
 * password file is the caller's; this function does NOT read or store it.
 */
export async function installPubkey(h: Host, pubPath: string, passwordFile: string): Promise<ExecResult> {
  const args = [
    "-f", passwordFile,
    "ssh-copy-id",
    "-i", pubPath,
    "-o", "PreferredAuthentications=password",
    "-o", "PubkeyAuthentication=no",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
  ];
  if (h.port) args.push("-p", String(h.port));
  args.push(`${h.user}@${h.host}`);
  return run("sshpass", args, 30000);
}

/** Overwrite then remove a file (best-effort) so the plaintext password is not left on disk. */
export function shredFile(path: string): void {
  try {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    writeFileSync(path, Buffer.alloc(size, 0));
    unlinkSync(path);
  } catch {
    // best-effort; ignore
  }
}

export interface ProvisionResult {
  ok: boolean;
  message: string;
}

/**
 * Full provisioning flow: generate a dedicated key, push it with the one-time
 * password, persist the key path in the registry, verify key-auth works, and
 * always shred the password file. After success the host authenticates by key
 * with no further password.
 */
export async function provisionHost(h: Host, passwordFile: string): Promise<ProvisionResult> {
  const reject = rejectUnsafePasswordFile(passwordFile);
  if (reject) return { ok: false, message: reject };
  if (!existsSync(passwordFile)) {
    return { ok: false, message: `password_file not found: ${passwordFile}` };
  }
  try {
    const { priv, pub } = await generateKey(h.name);
    const install = await installPubkey(h, pub, passwordFile);
    if (install.code === null) {
      return { ok: false, message: `Could not run sshpass/ssh-copy-id (is sshpass installed?): ${clip(install.stderr)}` };
    }
    if (install.code !== 0) {
      return { ok: false, message: `ssh-copy-id failed (exit ${install.code}): ${clip(install.stderr)}` };
    }
    addHost({ ...h, key: priv });
    const verify = await sshExec({ ...h, key: priv }, "true", 15000);
    if (verify.code !== 0) {
      return { ok: false, message: `Key installed but verification failed (exit ${verify.code}): ${clip(verify.stderr)}` };
    }
    return { ok: true, message: `Provisioned dedicated key for "${h.name}": ${priv}` };
  } finally {
    shredFile(passwordFile);
  }
}

/** Cap remote stderr before it reaches the transcript, in case a banner echoes session text. */
function clip(s: string): string {
  return s.trim().slice(0, 256);
}

/**
 * Guard against destroying the wrong file: shredFile zero-and-unlinks whatever
 * password_file points at. Refuse device files, our own provisioned keys, and
 * anything that looks like a real SSH private key.
 */
export function rejectUnsafePasswordFile(path: string): string | null {
  if (path.startsWith("/dev/")) return `Refusing device path as password_file: ${path}`;
  const base = basename(path);
  if (/^id_(rsa|ed25519|ecdsa|dsa)$/.test(base) || base.startsWith("ssh_mcp_") || base.endsWith(".pub")) {
    return `Refusing "${path}" as password_file: looks like an SSH key, not a one-time password file.`;
  }
  return null;
}

/** Hint shown when auth fails and no password_file was supplied. */
export function provisionHint(name: string): string {
  return [
    `No working credential for "${name}".`,
    `To auto-provision a dedicated key, write the password to a file (it stays out of the transcript):`,
    `  ! umask 077; printf %s 'THE_PASSWORD' > /tmp/sshpw_${name}`,
    `then re-run ssh_exec with password_file="/tmp/sshpw_${name}". The file is wiped (overwritten + deleted) after use.`,
  ].join("\n");
}
