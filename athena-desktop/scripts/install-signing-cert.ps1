# Installs the Athena Desktop code-signing certificate from Key Vault on this PC.
#   - Private key -> CurrentUser\My (non-exportable), so electron-builder can sign.
#   - Public cert -> CurrentUser\Root and CurrentUser\TrustedPublisher, so this PC trusts the signature.
# The PFX only ever exists in memory; nothing is written to disk.
# Requires: az login with "Key Vault Secrets User" on kv-athena-desktop.
param(
  [string]$Vault = 'kv-athena-desktop',
  [string]$Name = 'athena-desktop-signing',
  [string]$Subscription = 'Alliance Tenant Reporting'
)
$ErrorActionPreference = 'Stop'

$b64 = az keyvault secret show --subscription $Subscription --vault-name $Vault --name $Name --query value -o tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($b64)) { throw "Could not read $Name from Key Vault $Vault." }

$X509 = 'System.Security.Cryptography.X509Certificates'
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]'UserKeySet,PersistKeySet'
$cert = New-Object "$X509.X509Certificate2" -ArgumentList ([Convert]::FromBase64String($b64)), ([string]$null), $flags
if (-not $cert.HasPrivateKey) { throw 'The certificate from Key Vault has no private key.' }
$public = New-Object "$X509.X509Certificate2" -ArgumentList (, $cert.RawData)

function Add-ToStore([string]$storeName, $c) {
  $store = New-Object "$X509.X509Store" -ArgumentList $storeName, 'CurrentUser'
  $store.Open('ReadWrite')
  try { $store.Add($c) } finally { $store.Close() }
}

Add-ToStore 'My' $cert
Add-ToStore 'TrustedPublisher' $public
# Windows asks you to confirm adding a root certificate: choose Yes.
Add-ToStore 'Root' $public

Write-Output "Installed $($cert.Subject) ($($cert.Thumbprint)), expires $($cert.NotAfter.ToString('yyyy-MM-dd'))."
