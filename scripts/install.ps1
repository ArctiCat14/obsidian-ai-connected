<#
.SYNOPSIS
    Installs the AI Connected plugin into an Obsidian vault.

.DESCRIPTION
    Copies main.js, manifest.json and styles.css into
    <Vault>\.obsidian\plugins\ai-connected and prints the next steps.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Vault "C:\Users\Mark\obsidian\my-vault"

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Vault "D:\Notes" -Force
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Vault,

    # Overwrite existing files without asking.
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingDirectory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Vault not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).ProviderPath
}

$vaultRoot = Resolve-ExistingDirectory $Vault

# Refuse to install into a directory that does not look like an Obsidian vault
# unless it already has a .obsidian folder we can extend.
$obsidianDir = Join-Path $vaultRoot ".obsidian"
if (-not (Test-Path -LiteralPath $obsidianDir -PathType Container)) {
    if ($Force) {
        New-Item -ItemType Directory -Path $obsidianDir | Out-Null
        Write-Warning "Created $obsidianDir (this folder did not exist)."
    }
    else {
        throw "'$vaultRoot' does not contain a .obsidian folder. Open the folder once in Obsidian, or pass -Force."
    }
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $obsidianDir "plugins\ai-connected"

Write-Host "Vault:  $vaultRoot"
Write-Host "Target: $pluginDir"

$files = @("main.js", "manifest.json", "styles.css")
foreach ($name in $files) {
    $source = Join-Path $sourceRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing build artifact: $source. Run 'npm run build' first."
    }
}

New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null

foreach ($name in $files) {
    $source = Join-Path $sourceRoot $name
    $target = Join-Path $pluginDir $name
    if ((Test-Path -LiteralPath $target) -and -not $Force) {
        $answer = Read-Host "Overwrite $name? [y/N]"
        if ($answer -notmatch '^(y|yes)$') {
            Write-Host "Skipped $name"
            continue
        }
    }
    Copy-Item -LiteralPath $source -Destination $target -Force
    Write-Host "  copied $name"
}

# Enable the plugin in the community plugin list so the user only has to toggle it on.
# NOTE: parsed and serialised by hand — ConvertTo-Json in Windows PowerShell 5.1
# mangles single-element / nested arrays, which corrupted this file in testing.
$communityFile = Join-Path $obsidianDir "community-plugins.json"
$enabled = New-Object System.Collections.Generic.List[string]

if (Test-Path -LiteralPath $communityFile -PathType Leaf) {
    $raw = [System.IO.File]::ReadAllText($communityFile)
    if ($raw.Trim()) {
        try {
            $parsed = ConvertFrom-Json -InputObject $raw
            foreach ($item in @($parsed)) {
                if ($item -is [string] -and $item) {
                    [void]$enabled.Add($item)
                }
            }
        }
        catch {
            Write-Warning "Could not parse community-plugins.json - enable the plugin manually."
            $enabled = $null
        }
    }
}

if ($null -ne $enabled) {
    if (-not $enabled.Contains("ai-connected")) {
        [void]$enabled.Add("ai-connected")
        $lines = foreach ($name in $enabled) { '  "' + ($name -replace '\\', '\\\\' -replace '"', '\"') + '"' }
        $json = "[`n" + ($lines -join ",`n") + "`n]"
        [System.IO.File]::WriteAllText($communityFile, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "  enabled ai-connected in community-plugins.json"
    }
    else {
        Write-Host "  ai-connected is already in community-plugins.json"
    }
}

Write-Host ""
Write-Host "Done. In Obsidian: Settings -> Community plugins -> install/enable 'AI Connected'." -ForegroundColor Green
Write-Host "If Obsidian is already running, reload it (Ctrl+R) or toggle the plugin off/on."
