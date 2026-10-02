$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AntigravityCredentialReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags; public UInt32 Type; public IntPtr TargetName;
    public IntPtr Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
    public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern void CredFree(IntPtr credential);
}
'@
$pointer = [IntPtr]::Zero
if (-not [AntigravityCredentialReader]::Read('gemini:antigravity', 1, 0, [ref]$pointer)) {
  throw 'Antigravity Windows credential was not found'
}
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][AntigravityCredentialReader+Credential])
  if ($credential.CredentialBlobSize -eq 0 -or $credential.CredentialBlobSize -gt 65536) { throw 'Invalid Antigravity credential size' }
  $bytes = [byte[]]::new($credential.CredentialBlobSize)
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
  $value = if ($bytes.Length -gt 1 -and $bytes[1] -eq 0) { [Text.Encoding]::Unicode.GetString($bytes) } else { [Text.Encoding]::UTF8.GetString($bytes) }
  [Console]::Write($value.TrimEnd([char]0))
} finally { [AntigravityCredentialReader]::CredFree($pointer) }
