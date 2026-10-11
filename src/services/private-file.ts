import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomically write a user-only settings file on every supported platform. */
export function writePrivateFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    if (process.platform === "win32") enforceWindowsPrivateFile(temporary);
    else chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/**
 * Use .NET ACL APIs instead of the optional Microsoft.PowerShell.Security module. The explicit
 * post-write check keeps a successful helper invocation from being mistaken for private ACL proof.
 */
function enforceWindowsPrivateFile(path: string): void {
  const script = [
    "$ErrorActionPreference='Stop'",
    "if($args.Count -ne 1){throw 'Private ACL path argument is missing.'}",
    "$path=[IO.Path]::GetFullPath([string]$args[0])",
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "if($null -eq $sid){throw 'Current Windows SID is unavailable.'}",
    "$acl=$null; $extensions=$null",
    "try{$acl=[IO.File]::GetAccessControl($path)}catch{Add-Type -AssemblyName System.IO.FileSystem.AccessControl; $extensions=[type]::GetType('System.Security.AccessControl.FileSystemAclExtensions, System.IO.FileSystem.AccessControl'); if($null -eq $extensions){throw}; $acl=$extensions.GetMethod('GetAccessControl',[type[]]@([IO.FileInfo])).Invoke($null,@([IO.FileInfo]::new($path)))}",
    "$acl.SetAccessRuleProtection($true,$false)",
    "foreach($rule in @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))){$acl.RemoveAccessRuleSpecific($rule)}",
    "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]::None,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)",
    "$acl.AddAccessRule($rule)",
    "if($null -eq $extensions){try{[IO.File]::SetAccessControl($path,$acl)}catch{Add-Type -AssemblyName System.IO.FileSystem.AccessControl; $extensions=[type]::GetType('System.Security.AccessControl.FileSystemAclExtensions, System.IO.FileSystem.AccessControl'); $extensions.GetMethod('SetAccessControl',[type[]]@([IO.FileInfo],[System.Security.AccessControl.FileSecurity])).Invoke($null,@([IO.FileInfo]::new($path),$acl))}}else{$extensions.GetMethod('SetAccessControl',[type[]]@([IO.FileInfo],[System.Security.AccessControl.FileSecurity])).Invoke($null,@([IO.FileInfo]::new($path),$acl))}",
    "$check=$null; if($null -eq $extensions){$check=[IO.File]::GetAccessControl($path)}else{$check=$extensions.GetMethod('GetAccessControl',[type[]]@([IO.FileInfo])).Invoke($null,@([IO.FileInfo]::new($path)))}",
    "$rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if(!$check.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or !($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -or $rules[0].IsInherited){throw 'Private ACL verification failed.'}",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, path], { stdio: ["ignore", "ignore", "pipe"] });
}
