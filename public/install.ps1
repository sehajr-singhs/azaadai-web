# Installs the azaad command for the current user.
#   irm https://sehajr-singhs.github.io/azaadai-web/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Site = 'https://sehajr-singhs.github.io/azaadai-web'
$Bin = Join-Path $env:USERPROFILE '.azaad\bin'
New-Item -ItemType Directory -Force -Path $Bin | Out-Null

$py = $null
foreach ($c in @('py', 'python', 'python3')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notmatch 'WindowsApps') { $py = $c; break }
}
if (-not $py) { throw 'Python 3.9+ is required. Install it from https://www.python.org/downloads/ and run this again.' }

Invoke-WebRequest -UseBasicParsing "$Site/azaad.py" -OutFile (Join-Path $Bin 'azaad.py')
$launcher = if ($py -eq 'py') { 'py -3' } else { $py }
Set-Content -Encoding ASCII -Path (Join-Path $Bin 'azaad.cmd') -Value "@echo off`r`n$launcher `"%~dp0azaad.py`" %*"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $Bin) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $Bin), 'User')
    $env:Path += ";$Bin"
}
Write-Host ''
Write-Host 'azaad installed.' -ForegroundColor White
Write-Host 'Open a new terminal and run:  azaad'
