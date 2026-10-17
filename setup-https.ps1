$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$dataPath = Join-Path $PSScriptRoot '.tashrif-data'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null

$privateIpv4 = @(Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match '^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$' } |
    Select-Object -ExpandProperty IPAddress -Unique | Sort-Object)
if ($privateIpv4.Count -eq 0) { throw 'Sertifikat uchun lokal IPv4 manzil topilmadi. Wi-Fi tarmogiga ulang.' }

$myStore = 'Cert:\CurrentUser\My'
$rootStore = 'Cert:\CurrentUser\Root'
$caSubject = 'CN=Tashrif CRM Local Root CA'
$serverSubject = 'CN=Tashrif CRM Local Server'
$ca = Get-ChildItem $myStore | Where-Object { $_.Subject -eq $caSubject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Sort-Object NotAfter -Descending | Select-Object -First 1

if (-not $ca) {
    $ca = New-SelfSignedCertificate -Type Custom -Subject $caSubject -FriendlyName 'Tashrif CRM Local Root CA' `
        -CertStoreLocation $myStore -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
        -KeyUsage CertSign, CRLSign, DigitalSignature -NotAfter (Get-Date).AddYears(5) `
        -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0')
}

$caPath = Join-Path $dataPath 'tashrif-local-ca.cer'
Export-Certificate -Cert $ca -FilePath $caPath -Type CERT -Force | Out-Null
if (-not (Get-ChildItem $rootStore | Where-Object { $_.Thumbprint -eq $ca.Thumbprint })) {
    Import-Certificate -FilePath $caPath -CertStoreLocation $rootStore | Out-Null
}

$sanParts = @('DNS=localhost', 'IPAddress=127.0.0.1') + @($privateIpv4 | ForEach-Object { "IPAddress=$_" })
$extensions = @(
    "2.5.29.17={text}$($sanParts -join '&')",
    '2.5.29.37={text}1.3.6.1.5.5.7.3.1',
    '2.5.29.19={critical}{text}ca=0'
)
$serverCert = New-SelfSignedCertificate -Type Custom -Subject $serverSubject -FriendlyName 'Tashrif CRM HTTPS Server' `
    -Signer $ca -CertStoreLocation $myStore -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable -KeyUsage DigitalSignature, KeyEncipherment `
    -NotAfter (Get-Date).AddYears(1) -TextExtension $extensions

$randomBytes = New-Object byte[] 36
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($randomBytes)
$rng.Dispose()
$password = [Convert]::ToBase64String($randomBytes)
$securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
$pfxPath = Join-Path $dataPath 'https-server.pfx'
$passwordPath = Join-Path $dataPath 'https-password.txt'
Export-PfxCertificate -Cert $serverCert -FilePath $pfxPath -Password $securePassword -Force | Out-Null
Set-Content -LiteralPath $passwordPath -Value $password -NoNewline -Encoding ASCII

$sha = [System.Security.Cryptography.SHA256]::Create()
$caFingerprint = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($caPath))).Replace('-', '')
Set-Content -LiteralPath (Join-Path $dataPath 'https-ca-sha256.txt') -Value $caFingerprint -NoNewline -Encoding ASCII

$serverCert | Remove-Item -Force
Write-Host 'HTTPS sertifikati yaratildi. CA sertifikati joriy Windows foydalanuvchisi uchun ishonchli.' -ForegroundColor Green
Write-Host "Planshetga yuklanadigan sertifikat: $caPath"
Write-Host "Sertifikat SHA-256 izi: $caFingerprint"
foreach ($ip in $privateIpv4) { Write-Host "Planshet manzili: https://${ip}:8443/terminal" }
Write-Host 'Root CA fayli ozgarmasa, planshetga qayta ornatish shart emas.'
