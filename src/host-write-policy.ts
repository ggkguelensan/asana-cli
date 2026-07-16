import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  parseHostScopedWritePolicy,
  type ScopedWritePolicy,
} from "./write-policy";

export type HostWritePolicyPlatform = "darwin" | "linux" | "win32";

export interface HostScopedWritePolicyProvider {
  load(): Promise<ScopedWritePolicy>;
}

export type WindowsPolicyCommandResult = Readonly<{
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
}>;

/** Injectable only to exercise the fixed Windows inspector on non-Windows hosts. */
export type WindowsPolicyCommandRunner = (
  command: readonly string[],
) => Promise<WindowsPolicyCommandResult>;

export type FixedFileHostScopedWritePolicyProviderOptions = Readonly<{
  path?: string;
  platform?: HostWritePolicyPlatform;
  windowsCommandRunner?: WindowsPolicyCommandRunner;
}>;

const LINUX_POLICY_ROOT = "/etc";
const DARWIN_POLICY_ROOT = "/private/etc";
const WINDOWS_POLICY_PATH = "C:\\ProgramData\\asana-cli\\scoped-write-policy.json";
const WINDOWS_POWER_SHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const MAX_WINDOWS_POLICY_BYTES = 49_152;
const MAX_WINDOWS_POLICY_OUTPUT_BYTES = 65_536;
const MAX_WINDOWS_POLICY_ERROR_BYTES = 8_192;
const GROUP_OR_OTHER_WRITABLE = 0o022;

import WINDOWS_POLICY_INSPECTOR_SCRIPT from "../assets/windows-host-write-policy-inspector.ps1" with { type: "text" };

const WINDOWS_POLICY_COMMAND = Object.freeze([
  WINDOWS_POWER_SHELL_PATH,
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  WINDOWS_POLICY_INSPECTOR_SCRIPT,
]);
const WINDOWS_POLICY_ENV = Object.freeze({
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
});

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("Windows policy inspector output exceeded the limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function runWindowsPolicyInspector(
  command: readonly string[],
): Promise<WindowsPolicyCommandResult> {
  const process = Bun.spawn({
    cmd: [...command],
    env: WINDOWS_POLICY_ENV,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readBoundedBytes(process.stdout, MAX_WINDOWS_POLICY_OUTPUT_BYTES),
    readBoundedBytes(process.stderr, MAX_WINDOWS_POLICY_ERROR_BYTES),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function parseWindowsPolicyPayload(output: WindowsPolicyCommandResult): ScopedWritePolicy {
  if (
    output.exitCode !== 0 ||
    output.stdout.byteLength > MAX_WINDOWS_POLICY_OUTPUT_BYTES ||
    output.stderr.byteLength > MAX_WINDOWS_POLICY_ERROR_BYTES ||
    output.stderr.byteLength !== 0
  ) {
    throw new Error("Windows policy inspector failed");
  }

  const base64 = new TextDecoder("utf-8", { fatal: true }).decode(output.stdout);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("Windows policy inspector returned invalid output");
  }

  const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_WINDOWS_POLICY_BYTES ||
    Buffer.from(bytes).toString("base64") !== base64
  ) {
    throw new Error("Windows policy inspector returned invalid output");
  }

  return parseHostScopedWritePolicy(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

function posixPolicyPath(policyRoot: string, path: string): {
  readonly directories: readonly string[];
  readonly path: string;
} {
  const normalizedPath = resolve(path);
  const pathBelowPolicyRoot = relative(policyRoot, normalizedPath);
  if (
    pathBelowPolicyRoot.length === 0 ||
    pathBelowPolicyRoot === ".." ||
    pathBelowPolicyRoot.startsWith("../")
  ) {
    throw new Error("untrusted policy path");
  }

  const components = pathBelowPolicyRoot.split("/");
  let directory = policyRoot;
  const directories = [directory];
  for (const component of components.slice(0, -1)) {
    directory = join(directory, component);
    directories.push(directory);
  }
  return { directories, path: normalizedPath };
}

async function validateTrustedPosixDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await directory.stat();
    if (
      !metadata.isDirectory() ||
      metadata.uid !== 0 ||
      (metadata.mode & GROUP_OR_OTHER_WRITABLE) !== 0
    ) {
      throw new Error("untrusted policy directory");
    }
  } finally {
    await directory.close();
  }
}

function currentPlatform(): HostWritePolicyPlatform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}


/**
 * Returns the single host-administered policy location. The location deliberately
 * cannot be supplied through command arguments, stdin, environment, or an operation record.
 */
export function fixedHostScopedWritePolicyPath(
  platform: HostWritePolicyPlatform = currentPlatform(),
): string {
  if (platform === "win32") return WINDOWS_POLICY_PATH;
  return join(
    platform === "darwin" ? DARWIN_POLICY_ROOT : LINUX_POLICY_ROOT,
    "asana-cli",
    "scoped-write-policy.json",
  );
}

/** Loads only the fixed host configuration file; malformed or missing policy is denied by callers. */
export class FixedFileHostScopedWritePolicyProvider implements HostScopedWritePolicyProvider {
  readonly path: string;
  readonly platform: HostWritePolicyPlatform;
  readonly #windowsCommandRunner: WindowsPolicyCommandRunner;

  constructor(options: FixedFileHostScopedWritePolicyProviderOptions = {}) {
    this.platform = options.platform ?? currentPlatform();
    this.path = this.platform === "win32"
      ? WINDOWS_POLICY_PATH
      : options.path ?? fixedHostScopedWritePolicyPath(this.platform);
    this.#windowsCommandRunner = options.windowsCommandRunner ?? runWindowsPolicyInspector;
  }

  async load(): Promise<ScopedWritePolicy> {
    try {
      if (this.platform === "win32") {
        return parseWindowsPolicyPayload(
          await this.#windowsCommandRunner(WINDOWS_POLICY_COMMAND),
        );
      }

      const policyRoot = this.platform === "darwin" ? DARWIN_POLICY_ROOT : LINUX_POLICY_ROOT;
      const policy = posixPolicyPath(policyRoot, this.path);
      for (const directory of policy.directories) {
        await validateTrustedPosixDirectory(directory);
      }

      const file = await open(policy.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await file.stat();
        if (
          !metadata.isFile() ||
          metadata.uid !== 0 ||
          (metadata.mode & GROUP_OR_OTHER_WRITABLE) !== 0
        ) {
          throw new Error("untrusted policy file");
        }
        const text = await file.readFile({ encoding: "utf8" });
        const value: unknown = JSON.parse(text);
        return parseHostScopedWritePolicy(value);
      } finally {
        await file.close();
      }
    } catch {
      throw new Error("Host scoped write policy could not be loaded");
    }
  }
}
