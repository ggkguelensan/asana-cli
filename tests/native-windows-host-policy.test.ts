import { expect, test } from "bun:test";
import { FixedFileHostScopedWritePolicyProvider } from "../src/host-write-policy";
import type { ScopedWritePolicy } from "../src/write-policy";

const powerShellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const policyDirectoryPath = "C:\\ProgramData\\asana-cli";
const policyPath = `${policyDirectoryPath}\\scoped-write-policy.json`;

const acceptedPolicy: ScopedWritePolicy = {
  schema: "asana-cli.scoped-write-policy.v1",
  scopes: [{
    workspace_gid: "100",
    project_gids: ["200"],
    task_update_fields: ["name", "custom_fields"],
    custom_field_gids: ["300"],
    allow_comments: true,
  }],
};


const fixtureSetupScript = String.raw`
$ErrorActionPreference = 'Stop'
$policyDirectoryPath = 'C:\ProgramData\asana-cli'
$policyPath = 'C:\ProgramData\asana-cli\scoped-write-policy.json'
$sentinelPath = 'C:\ProgramData\asana-cli\native-windows-host-policy-test-sentinel'
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
$policyJson = '{"schema":"asana-cli.scoped-write-policy.v1","scopes":[{"workspace_gid":"100","project_gids":["200"],"task_update_fields":["name","custom_fields"],"custom_field_gids":["300"],"allow_comments":true}]}'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeWindowsDirectoryCreation {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CreateDirectory(string path, IntPtr securityAttributes);
}
'@

try {
  if (-not [NativeWindowsDirectoryCreation]::CreateDirectory($policyDirectoryPath, [IntPtr]::Zero)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 183) {
      throw 'Native Windows policy fixture setup refused because the fixed policy directory already exists'
    }
    throw "Native Windows policy fixture setup could not create the fixed policy directory (Win32 error $errorCode)"
  }

  $directorySecurity = [System.Security.AccessControl.DirectorySecurity]::new()
  $directorySecurity.SetAccessRuleProtection($true, $false)
  $directorySecurity.SetOwner($administratorsSid)
  $directorySecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, $fullControl, $allow))
  $directorySecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, $fullControl, $allow))
  [System.IO.Directory]::SetAccessControl($policyDirectoryPath, $directorySecurity)

  $randomNumberGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $sentinelBytes = New-Object byte[] 32
  $randomNumberGenerator.GetBytes($sentinelBytes)
  $randomNumberGenerator.Dispose()
  $sentinel = -join ($sentinelBytes | ForEach-Object { $_.ToString('X2') })
  [System.IO.File]::WriteAllText($sentinelPath, $sentinel, $utf8WithoutBom)
  [System.IO.File]::WriteAllText($policyPath, $policyJson, $utf8WithoutBom)

  $fileSecurity = [System.Security.AccessControl.FileSecurity]::new()
  $fileSecurity.SetAccessRuleProtection($true, $false)
  $fileSecurity.SetOwner($administratorsSid)
  $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, $fullControl, $allow))
  $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, $fullControl, $allow))
  [System.IO.File]::SetAccessControl($policyPath, $fileSecurity)

  $sentinel
} catch {
  throw "Native Windows policy fixture setup failed: $($_.Exception.Message)"
}
`;

const unsafeDaclMutationScript = String.raw`
param([Parameter(Mandatory = $true)][string]$expectedSentinel)
$ErrorActionPreference = 'Stop'
$policyDirectoryPath = 'C:\ProgramData\asana-cli'
$policyPath = 'C:\ProgramData\asana-cli\scoped-write-policy.json'
$sentinelPath = 'C:\ProgramData\asana-cli\native-windows-host-policy-test-sentinel'
$everyoneSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl

try {
  if ($expectedSentinel -cnotmatch '^[0-9A-F]{64}$' -or -not [System.IO.File]::Exists($sentinelPath) -or [System.IO.File]::ReadAllText($sentinelPath) -cne $expectedSentinel) {
    throw 'Native Windows policy fixture mutation refused because the test sentinel did not match'
  }
  $security = [System.IO.File]::GetAccessControl($policyPath)
  $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyoneSid, $fullControl, $allow))
  [System.IO.File]::SetAccessControl($policyPath, $security)
} catch {
  throw "Native Windows policy fixture unsafe DACL mutation failed: $($_.Exception.Message)"
}
`;

const fixtureSecurityRestoreScript = String.raw`
param([Parameter(Mandatory = $true)][string]$expectedSentinel)
$ErrorActionPreference = 'Stop'
$policyPath = 'C:\ProgramData\asana-cli\scoped-write-policy.json'
$sentinelPath = 'C:\ProgramData\asana-cli\native-windows-host-policy-test-sentinel'
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl

try {
  if ($expectedSentinel -cnotmatch '^[0-9A-F]{64}$' -or -not [System.IO.File]::Exists($sentinelPath) -or [System.IO.File]::ReadAllText($sentinelPath) -cne $expectedSentinel) {
    throw 'Native Windows policy fixture security restore refused because the test sentinel did not match'
  }
  $fileSecurity = [System.Security.AccessControl.FileSecurity]::new()
  $fileSecurity.SetAccessRuleProtection($true, $false)
  $fileSecurity.SetOwner($administratorsSid)
  $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, $fullControl, $allow))
  $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, $fullControl, $allow))
  [System.IO.File]::SetAccessControl($policyPath, $fileSecurity)
} catch {
  throw "Native Windows policy fixture security restore failed: $($_.Exception.Message)"
}
`;

const fixtureCleanupScript = String.raw`
param([Parameter(Mandatory = $true)][string]$expectedSentinel)
$ErrorActionPreference = 'Stop'
$policyDirectoryPath = 'C:\ProgramData\asana-cli'
$policyPath = 'C:\ProgramData\asana-cli\scoped-write-policy.json'
$sentinelPath = 'C:\ProgramData\asana-cli\native-windows-host-policy-test-sentinel'
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$none = [System.Security.AccessControl.InheritanceFlags]::None
$noPropagation = [System.Security.AccessControl.PropagationFlags]::None

function Assert-ExpectedSentinel {
  if ($expectedSentinel -cnotmatch '^[0-9A-F]{64}$') {
    throw 'Native Windows policy fixture cleanup refused because the expected sentinel was invalid'
  }
  if (-not [System.IO.Directory]::Exists($policyDirectoryPath) -or -not [System.IO.File]::Exists($sentinelPath)) {
    throw 'Native Windows policy fixture cleanup refused because the test sentinel was missing'
  }
  if ([System.IO.File]::ReadAllText($sentinelPath) -cne $expectedSentinel) {
    throw 'Native Windows policy fixture cleanup refused because the test sentinel did not match'
  }
}

function Assert-ProtectedTestAcl([string]$path, [bool]$isDirectory) {
  $security = if ($isDirectory) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
  if ($null -eq $security.Owner -or $security.Owner.Value -cne $administratorsSid.Value) {
    throw "Native Windows policy fixture cleanup refused because $path was not owned by Administrators"
  }
  if (-not $security.AreAccessRulesProtected) {
    throw "Native Windows policy fixture cleanup refused because $path did not have a protected DACL"
  }
  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) {
    throw "Native Windows policy fixture cleanup refused because $path did not have the test DACL"
  }
  foreach ($sid in @($systemSid.Value, $administratorsSid.Value)) {
    $matchingRules = @($rules | Where-Object {
      $_.IdentityReference.Value -ceq $sid -and
      $_.AccessControlType -eq $allow -and
      $_.FileSystemRights -eq $fullControl -and
      $_.InheritanceFlags -eq $none -and
      $_.PropagationFlags -eq $noPropagation
    })
    if ($matchingRules.Count -ne 1) {
      throw "Native Windows policy fixture cleanup refused because $path did not have the test DACL"
    }
  }
}

try {
  Assert-ExpectedSentinel
  Assert-ProtectedTestAcl $policyDirectoryPath $true
  Assert-ProtectedTestAcl $policyPath $false
  [System.IO.File]::SetAttributes($policyPath, [System.IO.FileAttributes]::Normal)
  [System.IO.File]::Delete($policyPath)
  [System.IO.File]::SetAttributes($sentinelPath, [System.IO.FileAttributes]::Normal)
  [System.IO.File]::Delete($sentinelPath)
  [System.IO.Directory]::Delete($policyDirectoryPath, $false)
} catch {
  throw "Native Windows policy fixture cleanup failed: $($_.Exception.Message)"
}
`;

function requireOutputStream(
  stream: Bun.Subprocess["stdout"],
  streamName: "stdout" | "stderr",
): ReadableStream<Uint8Array> {
  if (!(stream instanceof ReadableStream)) {
    throw new Error(`PowerShell did not provide a piped ${streamName} stream`);
  }
  return stream;
}

async function runPowerShell(script: string, phase: string, arguments_: string[] = []): Promise<string> {
  let process: Bun.Subprocess;
  const command = `& {\n${script}\n}`;
  try {
    process = Bun.spawn({
      cmd: [powerShellPath, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command, ...arguments_],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(`${phase} could not start PowerShell: ${String(error)}`);
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(requireOutputStream(process.stdout, "stdout")).text(),
    new Response(requireOutputStream(process.stderr, "stderr")).text(),
    process.exited,
  ]);
  if (exitCode !== 0 || stderr.length !== 0) {
    throw new Error(`${phase} failed (exit ${exitCode}): ${(stderr || stdout).trim()}`);
  }
  return stdout;
}

function parseFixtureSentinel(setupOutput: string): string {
  const match = /^([A-F0-9]{64})\r?\n?$/.exec(setupOutput);
  if (!match) {
    throw new Error("Native Windows policy fixture setup failed: setup did not emit exactly one valid sentinel");
  }
  return match[1];
}

const nativeWindowsTest = process.platform === "win32" ? test : test.skip;

nativeWindowsTest("loads the protected fixed Windows policy and denies a broad DACL", async () => {
  let fixtureSentinel: string | undefined;
  try {
    fixtureSentinel = parseFixtureSentinel(await runPowerShell(fixtureSetupScript, "Native Windows policy fixture setup"));

    const provider = new FixedFileHostScopedWritePolicyProvider({ platform: "win32" });
    await expect(provider.load()).resolves.toEqual(acceptedPolicy);

    await runPowerShell(unsafeDaclMutationScript, "Native Windows policy fixture mutation", [fixtureSentinel]);
    await expect(provider.load()).rejects.toThrow("Host scoped write policy could not be loaded");
  } finally {
    if (fixtureSentinel !== undefined) {
      await runPowerShell(fixtureSecurityRestoreScript, "Native Windows policy fixture security restore", [fixtureSentinel]);
      await runPowerShell(fixtureCleanupScript, "Native Windows policy fixture cleanup", [fixtureSentinel]);
    }
  }
}, 30_000);
