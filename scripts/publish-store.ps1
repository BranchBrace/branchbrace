<#
.SYNOPSIS
  Soumet un paquet MSIX de BranchBrace en certification sur le Microsoft Store.

.DESCRIPTION
  Utilise l'API de soumission du Microsoft Store :
  https://learn.microsoft.com/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services
  La nouvelle soumission reprend la fiche, la tarification et la classification de la
  dernière soumission publiée ; seul le paquet change (l'ancien est retiré). Elle est envoyée
  en certification, puis publiée automatiquement si elle passe.

  Le jeton d'accès vient de `az account get-access-token`. En CI, `azure/login` connecte par
  OIDC l'application Entra « github-store-submission », associée au compte Partner Center
  avec le rôle Gestionnaire : aucun secret n'est stocké.

.PARAMETER Msix
  Paquet à soumettre (produit par scripts/package-msix.ps1).

.PARAMETER DryRun
  Vérifie seulement l'accès à l'application et l'absence de soumission en cours.
#>
param(
  [string]$Msix,
  [string]$ProductId = '9N8TKSZ4DW55',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$base = "https://manage.devcenter.microsoft.com/v1.0/my/applications/$ProductId"

$token = az account get-access-token --resource https://manage.devcenter.microsoft.com --query accessToken -o tsv
if ($LASTEXITCODE -or -not $token) { throw "Jeton Partner Center introuvable : se connecter d'abord avec az login (ou azure/login en CI)." }
$headers = @{ Authorization = "Bearer $token" }

function Invoke-Store([string]$Method, [string]$Uri, $Body) {
  $request = @{ Method = $Method; Uri = $Uri; Headers = $headers; ContentType = 'application/json; charset=utf-8' }
  if ($null -ne $Body) { $request.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 64)) }
  Invoke-RestMethod @request
}

# Le paquet Electron pèse plus de 150 Mo : un PUT unique dépasse la limite d'un blob en un appel
# pour les anciennes versions de SAS (64 ou 256 Mo). Envoi en blocs de 4 Mio (Put Block puis
# Put Block List), accepté par toutes les versions du service.
function Send-Blob([string]$SasUrl, [string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $buffer = New-Object byte[] (4MB)
  $ids = [Collections.Generic.List[string]]::new()
  try {
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $chunk = New-Object byte[] $read
      [Array]::Copy($buffer, $chunk, $read)
      $id = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($ids.Count.ToString('d6')))
      Invoke-WebRequest -Method Put -Uri "$SasUrl&comp=block&blockid=$([Uri]::EscapeDataString($id))" -Body $chunk -ContentType 'application/octet-stream' | Out-Null
      $ids.Add($id)
    }
  } finally { $stream.Dispose() }
  $blockList = '<?xml version="1.0" encoding="utf-8"?><BlockList>' + (($ids | ForEach-Object { "<Latest>$_</Latest>" }) -join '') + '</BlockList>'
  Invoke-WebRequest -Method Put -Uri "$SasUrl&comp=blocklist" -Body $blockList -ContentType 'application/xml' | Out-Null
  Write-Host "Paquet téléversé : $($ids.Count) blocs."
}

$application = Invoke-Store GET $base $null
Write-Host "Application : $($application.primaryName) ($ProductId)"
if ($application.pendingApplicationSubmission) {
  throw "Une soumission est déjà en cours ($($application.pendingApplicationSubmission.id)) : la terminer ou la supprimer dans Partner Center."
}
if ($DryRun) {
  Write-Host "Accès vérifié, aucune soumission en cours. Dernière publiée : $($application.lastPublishedApplicationSubmission.id)"
  return
}

if (-not $Msix -or -not (Test-Path $Msix)) { throw "Paquet MSIX introuvable : $Msix" }
$fileName = Split-Path -Leaf $Msix

$submission = Invoke-Store POST "$base/submissions" $null
Write-Host "Soumission créée : $($submission.id)"
try {
  foreach ($package in $submission.applicationPackages) { $package.fileStatus = 'PendingDelete' }
  $submission.applicationPackages = @($submission.applicationPackages) + [pscustomobject]@{
    fileName = $fileName
    fileStatus = 'PendingUpload'
    minimumDirectXVersion = 'None'
    minimumSystemRam = 'None'
  }
  $submission = Invoke-Store PUT "$base/submissions/$($submission.id)" $submission

  # Le paquet se téléverse dans une archive zip, sur l'URL SAS fournie par la soumission.
  $zip = Join-Path ([IO.Path]::GetTempPath()) "store-submission-$($submission.id).zip"
  Compress-Archive -Path $Msix -DestinationPath $zip -Force
  Send-Blob $submission.fileUploadUrl $zip

  Invoke-Store POST "$base/submissions/$($submission.id)/commit" $null | Out-Null
} catch {
  Write-Warning "Échec : suppression de la soumission $($submission.id) pour pouvoir relancer."
  Invoke-Store DELETE "$base/submissions/$($submission.id)" $null | Out-Null
  throw
}

do {
  Start-Sleep -Seconds 30
  $status = Invoke-Store GET "$base/submissions/$($submission.id)/status" $null
  Write-Host "État : $($status.status)"
} while ($status.status -eq 'CommitStarted')

if ($status.status -eq 'CommitFailed') {
  $errors = $status.statusDetails.errors | ForEach-Object { "$($_.code) : $($_.details)" }
  throw "La soumission a échoué : $($errors -join ' ; ')"
}
Write-Host "$fileName envoyé en certification (soumission $($submission.id)) ; publication automatique si elle passe."
