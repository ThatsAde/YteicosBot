# Crea il package di deploy da caricare sul VPS.
#
#   powershell -ExecutionPolicy Bypass -File deploy\make-package.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\make-package.ps1 -IncludeDatabase
#
# Il package CONTIENE il .env con il token: non metterlo su Git, non passarlo
# su canali pubblici. Trasferimento previsto: scp (cifrato).
#
# Non contiene node_modules ne' dist: entrambi vengono ricostruiti sul VPS
# perche' il client Prisma e' compilato per il sistema su cui gira.
[CmdletBinding()]
param(
    # Copia anche prisma/dev.db, per portarsi dietro i dati gia' presenti in locale.
    [switch]$IncludeDatabase,
    # Lascia LOG_LEVEL com'e' invece di forzarlo a "info" per la produzione.
    [switch]$KeepLogLevel,
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutFile) { $OutFile = Join-Path $root 'yteicos-bot-deploy.tar.gz' }

if (-not (Test-Path (Join-Path $root '.env'))) {
    throw "Manca $root\.env: il package deve includerlo."
}

$stageRoot = Join-Path $env:TEMP ("yteicos-pkg-" + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $stageRoot 'yteicos-bot'
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
    Write-Host '==> Type-check del progetto prima di impacchettare'
    Push-Location $root
    & npx tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'tsc ha segnalato errori: correggili prima di fare il package.' }
    Pop-Location

    Write-Host '==> Copia dei file'

    # Sorgenti + configurazione di build
    Copy-Item -Recurse (Join-Path $root 'src') (Join-Path $stage 'src')
    Copy-Item -Recurse (Join-Path $root 'deploy') (Join-Path $stage 'deploy')
    foreach ($f in @('package.json', 'package-lock.json', 'tsconfig.json', '.env.example', '.gitignore', 'README.md')) {
        Copy-Item (Join-Path $root $f) (Join-Path $stage $f)
    }

    # Prisma: schema + migration. Il .db lo si porta solo su richiesta.
    New-Item -ItemType Directory -Path (Join-Path $stage 'prisma') -Force | Out-Null
    Copy-Item (Join-Path $root 'prisma\schema.prisma') (Join-Path $stage 'prisma\schema.prisma')
    Copy-Item -Recurse (Join-Path $root 'prisma\migrations') (Join-Path $stage 'prisma\migrations')

    if ($IncludeDatabase) {
        $db = Join-Path $root 'prisma\dev.db'
        if (Test-Path $db) {
            Copy-Item $db (Join-Path $stage 'prisma\dev.db')
            Write-Host '    dev.db incluso (dati locali portati sul VPS)'
        } else {
            Write-Warning '    -IncludeDatabase richiesto ma prisma\dev.db non esiste: saltato.'
        }
    } else {
        Write-Host '    dev.db NON incluso: sul VPS il database parte vuoto (usa -IncludeDatabase per portarlo)'
    }

    # .env: in produzione LOG_LEVEL=debug riempie il journal di rumore.
    $envLines = Get-Content (Join-Path $root '.env')
    if (-not $KeepLogLevel) {
        $envLines = $envLines | ForEach-Object {
            if ($_ -match '^\s*LOG_LEVEL\s*=') { 'LOG_LEVEL=info' } else { $_ }
        }
        Write-Host '    LOG_LEVEL forzato a "info" nel package (usa -KeepLogLevel per evitarlo)'
    }
    # UTF8 senza BOM: un BOM davanti a DISCORD_TOKEN romperebbe il parsing di dotenv.
    [IO.File]::WriteAllLines((Join-Path $stage '.env'), $envLines, (New-Object Text.UTF8Encoding $false))

    Write-Host '==> Creazione archivio'
    if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
    & tar -czf $OutFile -C $stageRoot 'yteicos-bot'
    if ($LASTEXITCODE -ne 0) { throw 'tar ha fallito.' }

    $size = [math]::Round((Get-Item $OutFile).Length / 1KB, 1)
    Write-Host ''
    Write-Host "Package pronto: $OutFile ($size KB)"
    Write-Host ''
    Write-Host 'Prossimi passi (vedi deploy\DEPLOY.md):'
    Write-Host "  scp `"$OutFile`" <utente>@<IP-VPS>:/tmp/"
    Write-Host '  ssh <utente>@<IP-VPS>'
    Write-Host '  tar -xzf /tmp/yteicos-bot-deploy.tar.gz -C /tmp && sudo rsync -a /tmp/yteicos-bot/ /opt/yteicos-bot/'
    Write-Host '  sudo bash /opt/yteicos-bot/deploy/scripts/install.sh'
}
finally {
    if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
}
