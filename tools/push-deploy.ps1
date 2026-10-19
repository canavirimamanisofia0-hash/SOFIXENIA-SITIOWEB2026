param([string]$LogPath)

Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
git push --progress -u origin main *>&1 | Out-File -LiteralPath $LogPath -Encoding utf8
exit $LASTEXITCODE
