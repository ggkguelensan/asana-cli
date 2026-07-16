$ErrorActionPreference = 'Stop'
$programDataPath = 'C:\ProgramData'
$mappingDirectoryPath = 'C:\ProgramData\asana-cli'
$mappingPath = 'C:\ProgramData\asana-cli\repository-asana-mapping.json'
$maximumMappingBytes = 49152
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$administratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

function Assert-FixedPathType {
  param([string]$Path, [bool]$ExpectDirectory)
  $attributes = [System.IO.File]::GetAttributes($Path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Reparse points are not trusted'
  }
  $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
  if ($isDirectory -ne $ExpectDirectory) {
    throw 'Unexpected repository mapping path type'
  }
}

function Test-TrustedIdentity {
  param([System.Security.Principal.SecurityIdentifier]$Identity)
  return $Identity.Value -eq $systemSid.Value -or $Identity.Value -eq $administratorsSid.Value
}

function Assert-ExactProtectedDacl {
  param([string]$Path)
  $security = Get-Acl -LiteralPath $Path
  if (-not $security.AreAccessRulesProtected) {
    throw 'Repository mapping DACL inheritance is not trusted'
  }
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  if (-not (Test-TrustedIdentity $owner)) {
    throw 'Repository mapping owner is not trusted'
  }
  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) {
    throw 'Repository mapping DACL is not exact'
  }
  $seen = @{}
  foreach ($rule in $rules) {
    $identity = [System.Security.Principal.SecurityIdentifier]$rule.IdentityReference
    if (
      $rule.IsInherited -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
      -not (Test-TrustedIdentity $identity) -or
      $seen.ContainsKey($identity.Value)
    ) {
      throw 'Repository mapping DACL is not exact'
    }
    $seen[$identity.Value] = $true
  }
  if (-not $seen.ContainsKey($systemSid.Value) -or -not $seen.ContainsKey($administratorsSid.Value)) {
    throw 'Repository mapping DACL is not exact'
  }
}

function Assert-SafeProgramDataDacl {
  $security = Get-Acl -LiteralPath $programDataPath
  $unsafeRights = [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) {
    throw 'ProgramData DACL is not trusted'
  }
  foreach ($rule in $rules) {
    $identity = [System.Security.Principal.SecurityIdentifier]$rule.IdentityReference
    if (
      -not ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -and
      -not (Test-TrustedIdentity $identity) -and
      (([int]$rule.FileSystemRights -band [int]$unsafeRights) -ne 0)
    ) {
      throw 'ProgramData grants unsafe control'
    }
  }
}

Assert-FixedPathType $programDataPath $true
Assert-FixedPathType $mappingDirectoryPath $true
Assert-FixedPathType $mappingPath $false
Assert-SafeProgramDataDacl
Assert-ExactProtectedDacl $mappingDirectoryPath
Assert-ExactProtectedDacl $mappingPath

$stream = [System.IO.File]::Open(
  $mappingPath,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::Read
)
try {
  if ($stream.Length -le 0 -or $stream.Length -gt $maximumMappingBytes) {
    throw 'Repository mapping size is not trusted'
  }
  $bytes = New-Object byte[] ([int]$stream.Length)
  $offset = 0
  while ($offset -lt $bytes.Length) {
    $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($read -le 0) {
      throw 'Repository mapping file changed while being read'
    }
    $offset += $read
  }
} finally {
  $stream.Dispose()
}

$text = New-Object System.Text.UTF8Encoding($false, $true)
$json = $text.GetString($bytes)
ConvertFrom-Json -InputObject $json -ErrorAction Stop | Out-Null
[System.Console]::Out.Write([System.Convert]::ToBase64String($bytes))
