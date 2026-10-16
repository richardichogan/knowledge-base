// electron-builder custom sign step: signs with the Athena Desktop certificate in
// CurrentUser\My via Windows' built-in Set-AuthenticodeSignature, so no signtool or
// winCodeSign download is needed. Install the certificate first:
//   powershell -File scripts/install-signing-cert.ps1
'use strict';
const { execFileSync } = require('node:child_process');

const SUBJECT = 'CN=Richard Hogan (Athena Desktop)';
const TIMESTAMP = 'http://timestamp.digicert.com';

exports.default = async function sign(configuration) {
  const file = configuration.path;
  const script = `
$ErrorActionPreference = 'Stop'
$cert = Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.Subject -eq $env:ATHENA_SIGN_SUBJECT -and $_.NotAfter -gt (Get-Date) } | Sort-Object NotAfter -Descending | Select-Object -First 1
if ($null -eq $cert) { throw "No valid code-signing certificate '$env:ATHENA_SIGN_SUBJECT' in CurrentUser\\My. Run scripts/install-signing-cert.ps1." }
$r = Set-AuthenticodeSignature -LiteralPath $env:ATHENA_SIGN_FILE -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $env:ATHENA_SIGN_TS
if ($null -eq $r.SignerCertificate -or $r.SignerCertificate.Thumbprint -ne $cert.Thumbprint) { throw "Signing failed for $env:ATHENA_SIGN_FILE : $($r.Status) $($r.StatusMessage)" }
Write-Output "signed $env:ATHENA_SIGN_FILE ($($r.Status))"
`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ATHENA_SIGN_FILE: file, ATHENA_SIGN_SUBJECT: SUBJECT, ATHENA_SIGN_TS: TIMESTAMP },
    encoding: 'utf8',
  });
  process.stdout.write(`  • ${out.trim()}\n`);
};
