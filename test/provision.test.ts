import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { keyPathFor, isAuthDenied, shredFile, rejectUnsafePasswordFile } from "../src/provision.ts";
import type { ExecResult } from "../src/ssh.ts";

function res(p: Partial<ExecResult>): ExecResult {
  return { code: null, stdout: "", stderr: "", timedOut: false, ...p };
}

test("keyPathFor builds a per-host path under ~/.ssh", () => {
  assert.equal(keyPathFor("cam1"), join(homedir(), ".ssh", "ssh_mcp_cam1_ed25519"));
});

test("keyPathFor rejects unsafe names (injection guard)", () => {
  assert.throws(() => keyPathFor("../evil"));
  assert.throws(() => keyPathFor("-rf"));
  assert.throws(() => keyPathFor("a b"));
});

test("isAuthDenied: true on publickey/password denial", () => {
  assert.equal(isAuthDenied(res({ code: 255, stderr: "Permission denied (publickey,password)." })), true);
});

test("isAuthDenied: false on host-key failure (provisioning cannot fix)", () => {
  assert.equal(isAuthDenied(res({ code: 255, stderr: "Host key verification failed." })), false);
});

test("isAuthDenied: false on timeout even if exit is 255", () => {
  assert.equal(isAuthDenied(res({ code: 255, stderr: "Permission denied", timedOut: true })), false);
});

test("rejectUnsafePasswordFile blocks keys and device paths", () => {
  assert.ok(rejectUnsafePasswordFile("/Users/x/.ssh/id_ed25519"));
  assert.ok(rejectUnsafePasswordFile("/Users/x/.ssh/ssh_mcp_cam1_ed25519"));
  assert.ok(rejectUnsafePasswordFile("/Users/x/.ssh/id_rsa.pub"));
  assert.ok(rejectUnsafePasswordFile("/dev/stdin"));
});

test("rejectUnsafePasswordFile allows a normal temp file", () => {
  assert.equal(rejectUnsafePasswordFile("/tmp/sshpw_cam1"), null);
});

test("isAuthDenied: false on success and on non-255 exit", () => {
  assert.equal(isAuthDenied(res({ code: 0 })), false);
  assert.equal(isAuthDenied(res({ code: 1, stderr: "command failed" })), false);
});

test("shredFile overwrites and removes the password file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sshmcp-"));
  const f = join(dir, "pw");
  writeFileSync(f, "hunter2");
  shredFile(f);
  assert.equal(existsSync(f), false);
});

test("shredFile is a no-op on a missing file", () => {
  assert.doesNotThrow(() => shredFile(join(tmpdir(), "definitely-not-here-xyz")));
});
