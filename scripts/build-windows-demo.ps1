param(
  [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
  [string]$OutputDirectory = ""
)
$ErrorActionPreference = "Stop"
$readerRoot = Split-Path $PSScriptRoot -Parent
$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
if (!(Test-Path -LiteralPath (Join-Path $releaseRoot "build-manifest.json"))) { throw "ReleaseDirectory must be a sealed release directory." }
foreach ($tool in @("node", "pnpm", "rustc", "cargo")) {
  if (!(Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing $tool. Install Node.js 22+, pnpm and Rust MSVC; see IMPLEMENTATION.md." }
}
if ([int]((& node -p "process.versions.node.split('.')[0]").Trim()) -lt 22) { throw "Node.js 22+ is required." }
$oldDemo = $env:READER_DEMO_RELEASE
$oldManifest = $env:VITE_RELEASE_MANIFEST
Push-Location $readerRoot
try {
  $env:READER_DEMO_RELEASE = $releaseRoot
  $env:VITE_RELEASE_MANIFEST = "/demo/manifest.json"
  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "Dependency install failed." }
  & pnpm --filter '@app/desktop' exec tauri build
  if ($LASTEXITCODE -ne 0) { throw "Native Windows build failed." }
  $bundle = Join-Path $readerRoot "apps/desktop/src-tauri/target/release/bundle/nsis"
  $installers = @(Get-ChildItem -LiteralPath $bundle -Filter '*.exe')
  if ($installers.Count -eq 0) { throw "NSIS installer missing after successful build." }
  if (!$OutputDirectory) { $OutputDirectory = Join-Path $readerRoot "windows-demo-output" }
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  foreach ($installer in $installers) { Copy-Item -LiteralPath $installer.FullName -Destination $OutputDirectory }
  $manifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'manifest.json') -Raw | ConvertFrom-Json
  $sourceCommit = $null
  $sourceWorktree = @()
  if (Test-Path -LiteralPath (Join-Path $readerRoot '.git')) {
    $sourceCommit = (& git rev-parse HEAD)
    $sourceWorktree = @(& git status --porcelain)
  } elseif (Test-Path -LiteralPath (Join-Path $readerRoot 'native-source.json')) {
    $sourceCommit = (Get-Content -LiteralPath (Join-Path $readerRoot 'native-source.json') -Raw | ConvertFrom-Json).reader_commit
  }
  $receipt = [ordered]@{
    status = 'compiled_candidate'; device_acceptance = 'pending'; release_id = $manifest.release_id;
    release_build_sha256 = (Get-FileHash -LiteralPath (Join-Path $releaseRoot 'build-manifest.json') -Algorithm SHA256).Hash.ToLower();
    reader_commit = $sourceCommit; reader_worktree = $sourceWorktree;
    installers = @($installers | ForEach-Object { [ordered]@{ name=$_.Name; bytes=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower() } });
    compiled_at = [DateTime]::UtcNow.ToString('o')
  }
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'windows-build-receipt.json') -Encoding UTF8
  Write-Host "Windows candidates and build receipt: $OutputDirectory"
} finally {
  $env:READER_DEMO_RELEASE = $oldDemo
  $env:VITE_RELEASE_MANIFEST = $oldManifest
  Pop-Location
}
