import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative, resolve, win32 } from "node:path";
import {
  parseHostScopedWritePolicy,
  type ScopedWritePolicy,
} from "./write-policy";

export type HostWritePolicyPlatform = "darwin" | "linux" | "win32";

export interface HostScopedWritePolicyProvider {
  load(): Promise<ScopedWritePolicy>;
}

export type FixedFileHostScopedWritePolicyProviderOptions = Readonly<{
  path?: string;
  platform?: HostWritePolicyPlatform;
}>;

const LINUX_POLICY_ROOT = "/etc";
const DARWIN_POLICY_ROOT = "/private/etc";
const GROUP_OR_OTHER_WRITABLE = 0o022;

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
  if (platform === "win32") {
    return win32.join("C:\\ProgramData", "asana-cli", "scoped-write-policy.json");
  }
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

  constructor(options: FixedFileHostScopedWritePolicyProviderOptions = {}) {
    this.platform = options.platform ?? currentPlatform();
    this.path = options.path ?? fixedHostScopedWritePolicyPath(this.platform);
  }

  async load(): Promise<ScopedWritePolicy> {
    try {
      if (this.platform === "win32") {
        throw new Error("untrusted policy platform");
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
