<#
  Signe TOUT ce qui doit l'etre apres un `npm run dist`, dans le bon ordre :

  1. Signe l'exe interne dans dist/win-unpacked (celui qu'electron-builder
     recopie tel quel dans l'installation NSIS et dans le portable).
  2. Re-package l'installeur NSIS + le portable A PARTIR de ce dossier deja
     signe (--prepackaged), sans re-télécharger/re-unpacker Electron.
  3. Signe les deux EXE finaux (l'enveloppe installeur et l'enveloppe portable).

  Sans l'etape 1, seules les enveloppes exterieures etaient signees : une fois
  installee (ou extraite par le portable), l'app elle-meme restait "NotSigned"
  et pouvait etre bloquee par le Controle intelligent des applications au
  premier lancement reel.

  Le certificat doit deja exister dans Cert:\CurrentUser\My sur cette machine
  (genere une seule fois, voir README.md section "Signature de l'application").

  Volontairement SANS horodatage (-TimestampServer) : un timestamp change les
  octets du fichier a chaque signature (donc son empreinte/hash), ce qui
  repart a zero pour la reputation cloud de Windows a chaque re-signature,
  meme sur un code inchange. Sans horodatage, re-signer un contenu identique
  avec le meme certificat produit exactement le meme fichier (signature RSA
  deterministe) - la seule contrepartie est que la signature devient
  techniquement invalide apres expiration du certificat (2036 ici).
#>
param(
  [string]$Thumbprint = "1FA4784FC8E839DFC44EECE8C3733231BE3C95FA"
)

$ErrorActionPreference = 'Stop'

$cert = Get-Item "Cert:\CurrentUser\My\$Thumbprint" -ErrorAction SilentlyContinue
if (-not $cert) {
  Write-Error "Certificat introuvable (thumbprint $Thumbprint) dans Cert:\CurrentUser\My. Voir README.md pour en regenerer un."
  exit 1
}

$root = Join-Path $PSScriptRoot ".."
$distDir = Join-Path $root "dist"
$unpackedDir = Join-Path $distDir "win-unpacked"
$innerExe = Join-Path $unpackedDir "Fiches Maintenance.exe"
$qpdfExe = Join-Path $unpackedDir "resources\qpdf\qpdf.exe"

function Sign-File($path) {
  Write-Output "Signature de : $path"
  $sig = Set-AuthenticodeSignature -FilePath $path -Certificate $cert -HashAlgorithm SHA256
  Write-Output "  -> $($sig.Status) : $($sig.StatusMessage)"
}

if (-not (Test-Path $innerExe)) {
  Write-Error "Introuvable : $innerExe. Lancez d'abord 'npm run dist'."
  exit 1
}

Write-Output "--- Etape 1/3 : signature de l'exe interne (win-unpacked) ---"
Sign-File $innerExe
if (Test-Path $qpdfExe) {
  # qpdf.exe est lance en sous-processus par l'app (protection PDF par mot de
  # passe) : Smart App Control peut l'evaluer independamment de l'exe
  # principal au moment de son execution, meme signe.
  Sign-File $qpdfExe
} else {
  Write-Warning "qpdf.exe introuvable dans win-unpacked (resources/qpdf) : non signe."
}

Write-Output "--- Etape 2/3 : re-packaging NSIS + portable depuis l'exe signe ---"
Push-Location $root
try {
  & npx electron-builder --prepackaged "dist\win-unpacked" --win nsis portable
  if ($LASTEXITCODE -ne 0) { throw "electron-builder --prepackaged a echoue (code $LASTEXITCODE)" }
} finally {
  Pop-Location
}

Write-Output "--- Etape 3/3 : signature des EXE finaux ---"
Get-ChildItem $distDir -Filter *.exe | ForEach-Object { Sign-File $_.FullName }

Write-Output ""
Write-Output "Termine. Statut 'UnknownError' = normal si le certificat n'est pas encore approuve sur CETTE machine"
Write-Output "(la signature est bien ecrite ; seule la verification locale echoue tant que le .cer n'est pas importe)."
