param(
    [switch]$major,
    [switch]$minor,
    [switch]$patch
)

if (-not $major -and -not $minor -and -not $patch) {
    Write-Error "Usage: .\release.ps1 -major | -minor | -patch"
    exit 1
}

# Read current version from package.json
$pkg = Get-Content "package.json" | ConvertFrom-Json
$current = $pkg.version
$parts = $current -split '\.'
$maj = [int]$parts[0]
$min = [int]$parts[1]
$pat = [int]$parts[2]

if ($major) { $maj++; $min = 0; $pat = 0 }
elseif ($minor) { $min++; $pat = 0 }
elseif ($patch) { $pat++ }

$newVersion = "$maj.$min.$pat"
$tag = "v$newVersion"

Write-Host "Bumping $current -> $newVersion"

# Update version in package.json
$pkg.version = $newVersion
$pkg | ConvertTo-Json -Depth 10 | Set-Content "package.json"

# Rebuild dist with new version baked in
Write-Host "Building..."
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Commit, tag, push
$branch = git rev-parse --abbrev-ref HEAD
git add package.json dist/
git commit -m "chore: release $tag"
git tag $tag
git push origin $branch
git push origin $tag

Write-Host "Done - $tag pushed to origin"
