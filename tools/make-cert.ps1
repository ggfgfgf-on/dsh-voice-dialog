$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'dsh-voice-https'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$pfx = Join-Path $dir 'dsh-voice.pfx'
$cer = Join-Path $dir 'dsh-voice.cer'
$pass = 'dsh-voice'
$sans = @('localhost', '127.0.0.1', '10.104.83.170')
$ext = @('2.5.29.19={text}ca=true&pathlength=0')
$cert = New-SelfSignedCertificate -DnsName $sans -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(3) -KeyExportPolicy Exportable -KeyLength 2048 -KeyAlgorithm 'RSA' -TextExtension $ext -FriendlyName 'DSH voice https'
if (Test-Path $pfx) { Remove-Item $pfx -Force }
$secure = ConvertTo-SecureString -String $pass -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cer -Type CERT | Out-Null
Write-Output ('pfx=' + $pfx)
Write-Output ('cer=' + $cer)
Write-Output ('thumbprint=' + $cert.Thumbprint)
Write-Output ('notAfter=' + $cert.NotAfter.ToString('o'))
Write-Output ('dns=' + (($cert.DnsNameList | ForEach-Object { $_.Unicode }) -join ','))
