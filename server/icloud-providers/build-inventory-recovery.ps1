$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$toolRoot = Join-Path $projectRoot 'tools/icloudpd'
$sourceRoot = Join-Path $toolRoot 'source-review/icloud_photos_downloader-master'
$python = Join-Path $sourceRoot '.venv/Scripts/python.exe'
$basePath = Join-Path $sourceRoot 'src/icloudpd/base.py'
$base = [IO.File]::ReadAllText($basePath)
if (-not $base.Contains('from icloudpd.framebase_inventory_recovery import inventory_recovery')) {
    $base = $base.Replace('import datetime', "from icloudpd.framebase_inventory_recovery import inventory_recovery`n`nimport datetime")
}
if (-not $base.Contains('else inventory_recovery(photo_album)')) {
    $old = 'if framebase_delete_assets else photo_album'
    if (-not $base.Contains($old)) { throw 'Cannot find inventory iterator; review the compatibility source before rebuilding.' }
    $base = $base.Replace($old, 'if framebase_delete_assets else inventory_recovery(photo_album) if os.environ.get("FRAMEBASE_INVENTORY_RECOVERY_POLICY") and os.environ.get("FRAMEBASE_INVENTORY_JSON") == "1" else photo_album')
}
[IO.File]::WriteAllText($basePath, $base, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'inventory-recovery.py') -Destination (Join-Path $sourceRoot 'src/icloudpd/framebase_inventory_recovery.py')
$starterPath = Join-Path $sourceRoot 'src/starters/icloudpd.py'
$starter = [IO.File]::ReadAllText($starterPath)
if (-not $starter.Contains('FrameBase inventory recovery')) {
    $starter = $starter.Replace('    result = cli()', "    if `"--version`" in sys.argv:`n        print(`"version:1.32.3 · FrameBase inventory recovery`")`n        return 0`n    result = cli()")
    [IO.File]::WriteAllText($starterPath, $starter, [Text.UTF8Encoding]::new($false))
}
Push-Location $sourceRoot
try {
    & $python -m PyInstaller --noconfirm --distpath (Join-Path $toolRoot 'dist-inventory-recovery') --workpath (Join-Path $toolRoot 'build-inventory-recovery') icloudpd-framebase-compatible.spec
    if ($LASTEXITCODE -ne 0) { throw 'Compatibility tool build failed.' }
} finally { Pop-Location }
# Keep the previous executable available, including for running tasks.
Copy-Item -LiteralPath (Join-Path $toolRoot 'dist-inventory-recovery/icloudpd-framebase-compatible.exe') -Destination (Join-Path $toolRoot 'icloudpd-framebase-inventory-recovery.exe')
