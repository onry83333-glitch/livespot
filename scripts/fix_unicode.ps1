$filePath = 'C:\dev\livespot\frontend\src\app\casts\[castName]\sessions\[sessionId]\page.tsx'
$content = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)

# Replace \uXXXX with actual Unicode characters
# Handle surrogate pairs for emoji (e.g. \uD83D\uDCFA)
$converted = [System.Text.RegularExpressions.Regex]::Replace(
    $content,
    '\\u([0-9A-Fa-f]{4})',
    {
        param($m)
        $hex = $m.Groups[1].Value
        $code = [Convert]::ToInt32($hex, 16)
        return [char]$code
    }
)

# Write back as UTF-8 with BOM
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($filePath, $converted, $utf8NoBom)

Write-Output "Conversion complete."

# Verify - show LABELS section
$lines = [System.IO.File]::ReadAllLines($filePath, [System.Text.Encoding]::UTF8)
Write-Output "LABELS section (lines 47-100):"
for ($i = 46; $i -lt [Math]::Min(100, $lines.Length); $i++) {
    Write-Output ("{0,4}: {1}" -f ($i+1), $lines[$i])
}
