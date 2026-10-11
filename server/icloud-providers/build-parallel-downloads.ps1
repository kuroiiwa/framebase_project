$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$toolRoot = Join-Path $projectRoot 'tools/icloudpd'
$sourceRoot = Join-Path $toolRoot 'source-review/icloud_photos_downloader-master'
$python = Join-Path $sourceRoot '.venv/Scripts/python.exe'
& $python (Join-Path $PSScriptRoot 'enable-parallel-downloads.py') $sourceRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot apply download concurrency changes.' }
& $python (Join-Path $PSScriptRoot 'enable-delete-indexing-compat.py') $sourceRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot apply deletion indexing compatibility changes.' }
$starterPath = Join-Path $sourceRoot 'src/starters/icloudpd.py'
$starter = [IO.File]::ReadAllText($starterPath)
$starter = $starter.Replace('FrameBase inventory recovery', 'FrameBase inventory recovery + parallel downloads')
$starter = $starter.Replace(' + parallel downloads + parallel downloads', ' + parallel downloads')
[IO.File]::WriteAllText($starterPath, $starter, [Text.UTF8Encoding]::new($false))
Push-Location $sourceRoot
try {
    & $python -m PyInstaller --noconfirm --distpath (Join-Path $toolRoot 'dist-parallel-downloads') --workpath (Join-Path $toolRoot 'build-parallel-downloads') icloudpd-framebase-compatible.spec
    if ($LASTEXITCODE -ne 0) { throw 'Parallel download tool build failed.' }
} finally { Pop-Location }
Copy-Item -LiteralPath (Join-Path $toolRoot 'dist-parallel-downloads/icloudpd-framebase-compatible.exe') -Destination (Join-Path $toolRoot 'icloudpd-framebase-parallel-downloads.exe')
