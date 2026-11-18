<#
.SYNOPSIS
  Construit le paquet MSIX de BranchBrace destiné au Microsoft Store.

.DESCRIPTION
  Lance `npm run package:msix` (cible electron-builder « appx ») avec la version stable
  demandée. Le makeappx.exe embarqué par electron-builder plante : ce script pointe
  ELECTRON_BUILDER_WINDOWS_KITS_PATH vers le makeappx.exe et le makepri.exe du Windows SDK
  installé (version la plus récente). Le Store exige une version X.Y.Z.0 : le script vérifie
  celle écrite dans l'AppxManifest.xml du paquet produit et écrit le chemin du paquet en sortie.

  Le paquet n'est pas signé : le Store le signe après certification.

.PARAMETER Version
  Version stable X.Y.Z (sans « v » ni suffixe de pré-release).
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$kits = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
if (-not $kits) { throw 'Windows SDK introuvable : makeappx.exe absent de « Windows Kits\10\bin\10.*\x64 ».' }
$env:ELECTRON_BUILDER_WINDOWS_KITS_PATH = $kits.DirectoryName
Write-Host "Windows SDK : $($kits.DirectoryName)"

# Aucune variable BUILD_NUMBER & co : electron-builder met alors la 4e partie de la version à 0.
foreach ($name in 'BUILD_NUMBER', 'TRAVIS_BUILD_NUMBER', 'APPVEYOR_BUILD_NUMBER', 'CIRCLE_BUILD_NUM', 'BUILD_BUILDNUMBER', 'CI_PIPELINE_IID') {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

Remove-Item artifacts\*.appx, artifacts\*.msix -ErrorAction SilentlyContinue
# Out-Host : la seule sortie du script reste le chemin du paquet.
npm run package:msix -- "-c.extraMetadata.version=$Version" | Out-Host
if ($LASTEXITCODE) { throw "npm run package:msix a échoué ($LASTEXITCODE)." }

$package = @(Get-ChildItem artifacts\*.appx, artifacts\*.msix -ErrorAction SilentlyContinue)
if ($package.Count -ne 1) { throw "Un paquet attendu dans artifacts\, trouvé : $($package.Count)." }
$package = $package[0]

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($package.FullName)
try {
  $reader = New-Object IO.StreamReader($archive.GetEntry('AppxManifest.xml').Open())
  [xml]$manifest = $reader.ReadToEnd()
  $reader.Dispose()
} finally { $archive.Dispose() }
$identity = $manifest.Package.Identity
if ($identity.Version -ne "$Version.0") { throw "Version du paquet $($identity.Version), attendue $Version.0." }
if ($identity.Name -ne 'AntoineMonnier.BranchBrace') { throw "Identité du paquet inattendue : $($identity.Name)." }

Write-Host "Paquet : $($package.FullName) ($($identity.Name) $($identity.Version), $([math]::Round($package.Length / 1MB)) Mo)"
$package.FullName
