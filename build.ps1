# Script to build a clean ZIP file for the Chrome Web Store

$zipName = "stupefy-extension-v1.0.0.zip"
$filesToInclude = @(
    "src",
    "icons",
    "manifest.json",
    "PRIVACY_POLICY.html"
)

Write-Host "Packaging Stupefy! for Chrome Web Store..." -ForegroundColor Cyan

# Remove old zip if it exists
if (Test-Path $zipName) {
    Remove-Item $zipName -Force
}

# Compress the specific files and folders
Compress-Archive -Path $filesToInclude -DestinationPath $zipName -Force

Write-Host "✅ Done! Successfully created: $zipName" -ForegroundColor Green
Write-Host "Upload this file directly to the Chrome Developer Dashboard." -ForegroundColor Yellow
