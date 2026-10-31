param(
  [ValidateSet('Init', 'Confirm', 'Status', 'Reset', 'ReadForRouter', 'SelfTest')]
  [string]$Action = 'Status',
  [string]$Code
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$secretDir = Join-Path $env:LOCALAPPDATA 'WCM\secrets'
$secretPath = Join-Path $secretDir 'totp.dpapi'
$policyScript = Join-Path $PSScriptRoot 'set-wcm-approval-mode.ps1'

function Get-Secret {
  if (-not (Test-Path -LiteralPath $secretPath)) {
    throw 'WCM TOTP has not been initialized for this Windows account.'
  }
  $ciphertext = [IO.File]::ReadAllBytes($secretPath)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $ciphertext, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  if ($plain.Length -ne 20) { throw 'Invalid WCM TOTP secret length.' }
  return ,$plain
}

function ConvertTo-Base32([byte[]]$Data) {
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  $result = New-Object System.Text.StringBuilder
  $buffer = 0
  $bits = 0
  foreach ($value in $Data) {
    $buffer = ($buffer -shl 8) -bor [int]$value
    $bits += 8
    while ($bits -ge 5) {
      $bits -= 5
      [void]$result.Append($alphabet[($buffer -shr $bits) -band 31])
      $buffer = $buffer -band ((1 -shl $bits) - 1)
    }
  }
  if ($bits -gt 0) { [void]$result.Append($alphabet[($buffer -shl (5 - $bits)) -band 31]) }
  return $result.ToString()
}

function Get-Totp([byte[]]$Secret, [long]$Counter) {
  $message = [BitConverter]::GetBytes([long]$Counter)
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($message) }
  $hmac = New-Object System.Security.Cryptography.HMACSHA1(,$Secret)
  try { $digest = $hmac.ComputeHash([byte[]]$message) }
  finally { $hmac.Dispose() }
  $offset = $digest[19] -band 15
  $binary = (([int]($digest[$offset] -band 127)) -shl 24) -bor
    (([int]$digest[$offset + 1]) -shl 16) -bor
    (([int]$digest[$offset + 2]) -shl 8) -bor
    ([int]$digest[$offset + 3])
  return ([int]($binary % 1000000)).ToString('D6')
}

function Test-Code([byte[]]$Secret, [string]$Provided) {
  if ($Provided -cnotmatch '^[0-9]{6}$') { return $false }
  $counter = [long][Math]::Floor(([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) / 30)
  foreach ($offset in @(-1, 0, 1)) {
    $step = $counter + $offset
    if ((Get-Totp $Secret $step) -ceq $Provided) { return $true }
  }
  return $false
}

switch ($Action) {
  'SelfTest' {
    $knownSecret = [Text.Encoding]::ASCII.GetBytes('12345678901234567890')
    if ((Get-Totp $knownSecret 1) -ne '287082') { throw 'TOTP implementation did not match the RFC test vector.' }
    if ((Get-Totp $knownSecret 37037036) -ne '081804') { throw 'TOTP implementation failed the second RFC test vector.' }
    $currentCounter = [long][Math]::Floor(([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) / 30)
    foreach ($offset in @(-1, 0, 1)) {
      $liveTestCode = Get-Totp $knownSecret ($currentCounter + $offset)
      if (-not (Test-Code $knownSecret $liveTestCode)) {
        throw ('TOTP confirmation check failed for time offset ' + $offset + '.')
      }
    }
    if (Test-Code $knownSecret 'invalid') { throw 'TOTP confirmation accepted invalid code.' }
    Write-Output 'TOTP PowerShell self-test: PASS'
    break
  }
  'Init' {
    if (Test-Path -LiteralPath $secretPath) {
      throw 'WCM TOTP already exists. Use Status or explicit Reset; Init never rotates the existing phone secret.'
    }
    [IO.Directory]::CreateDirectory($secretDir) | Out-Null
    $secret = New-Object byte[] 20
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($secret) }
    finally { $rng.Dispose() }
    $ciphertext = [Security.Cryptography.ProtectedData]::Protect(
      $secret, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllBytes($secretPath, $ciphertext)
    $base32 = ConvertTo-Base32 $secret
    Write-Output 'WCM phone authenticator setup (ONLY in your own 6v terminal):'
    Write-Output ('Windows account: ' + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
    Write-Output ('Account label: WCM (6v)')
    Write-Output ('Manual setup key: ' + $base32)
    Write-Output ('OTP URI: otpauth://totp/WCM:6v?secret=' + $base32 + '&issuer=WCM&algorithm=SHA1&digits=6&period=30')
    Write-Output 'Add this key to a TOTP app as SHA1 / 6 digits / 30 seconds.'
    Write-Output 'Next, run Confirm with one code shown by the app. That switches WCM to TOTP mode.'
    Write-Output 'Do not paste this setup key or OTP URI into ChatGPT.'
    break
  }
  'Confirm' {
    if (-not (Test-Code (Get-Secret) $Code)) { throw 'Invalid authenticator code; WCM approval mode was not changed.' }
    & $policyScript -Mode Totp
    Write-Output 'Phone paired and WCM switched to TOTP approval mode. Existing timed grants are revoked by the policy revision.'
    break
  }
  'ReadForRouter' {
    Write-Output ([Convert]::ToBase64String((Get-Secret)))
    break
  }
  'Reset' {
    if (Test-Path -LiteralPath $secretPath) {
      Remove-Item -LiteralPath $secretPath -Force
    }
    $replayPath = Join-Path $secretDir 'totp-unlock-state.json'
    if (Test-Path -LiteralPath $replayPath) { Remove-Item -LiteralPath $replayPath -Force }
    & $policyScript -RevokeAll
    Write-Output 'TOTP pairing reset. All active WCM grants revoked. Run Init and Confirm to pair again.'
    break
  }
  'Status' {
    Write-Output ('Windows account: ' + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
    Write-Output ('TOTP paired locally: ' + (Test-Path -LiteralPath $secretPath))
    & $policyScript -Status
    break
  }
}
