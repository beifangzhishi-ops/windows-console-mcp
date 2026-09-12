param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ArgsRest
)

$env:PYTHONUTF8 = '1'
$script = Join-Path $PSScriptRoot 'cloud_transfer.py'
& python $script @ArgsRest
exit $LASTEXITCODE
