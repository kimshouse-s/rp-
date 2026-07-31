#requires -Version 5.1
# 앱 실행 스크립트. 앱실행.bat 이 이 파일을 호출한다.
# 한글 메시지는 전부 여기 있다. 배치 파일은 코드페이지에 따라 한글이 깨지지만
# PowerShell 은 BOM 이 있으면 콘솔 코드페이지와 무관하게 이 파일을 정확히 읽는다.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Set-Location -LiteralPath $PSScriptRoot
$Host.UI.RawUI.WindowTitle = 'Gemini 롤플레이 메신저'

function Pause-Exit([int]$code = 0) {
    Write-Host ''
    Read-Host '창을 닫으려면 Enter 를 누르세요'
    exit $code
}

Write-Host ''
Write-Host '  ===========================================' -ForegroundColor DarkGray
Write-Host '   Gemini 롤플레이 메신저' -ForegroundColor Cyan
Write-Host '  ===========================================' -ForegroundColor DarkGray
Write-Host ''

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host '  [오류] Node.js 를 찾을 수 없습니다.' -ForegroundColor Red
    Write-Host '         https://nodejs.org 에서 설치한 뒤 다시 실행하세요.'
    Pause-Exit 1
}

if (-not (Test-Path 'node_modules')) {
    Write-Host '  처음 실행이라 필요한 파일을 받습니다. 몇 분 걸립니다...' -ForegroundColor Yellow
    Write-Host ''
    & npm install
    Write-Host ''
}

# .env.local 의 키가 비어 있으면 알려준다. 없어도 앱은 뜨지만 응답 생성이 안 된다.
$hasKey = $false
if (Test-Path '.env.local') {
    $line = Select-String -Path '.env.local' -Pattern '^\s*GEMINI_API_KEY\s*=\s*(.+)$' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line -and $line.Matches[0].Groups[1].Value.Trim()) { $hasKey = $true }
}

if (-not $hasKey) {
    Write-Host '  [알림] Gemini API 키가 비어 있습니다.' -ForegroundColor Yellow
    Write-Host '         키가 없으면 화면은 떠도 응답 생성이 안 됩니다.'
    Write-Host ''
    Write-Host '         키 받는 곳 : https://aistudio.google.com/apikey'
    Write-Host '         넣는 곳    : 이 폴더의 .env.local 파일'
    Write-Host ''
}

Write-Host '  서버를 시작합니다. 브라우저가 곧 자동으로 열립니다.' -ForegroundColor Green
Write-Host '  끄려면 이 창을 닫으세요.'
Write-Host ''

# 서버가 뜰 때까지 잠깐 기다렸다가 브라우저를 연다.
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-Command',
    'Start-Sleep -Seconds 5; Start-Process "http://localhost:3000"'
) | Out-Null

try {
    & npm run dev
} catch {
    Write-Host ''
    Write-Host "  [오류] 서버 실행에 실패했습니다: $_" -ForegroundColor Red
}

Write-Host ''
Write-Host '  서버가 종료되었습니다.'
Pause-Exit 0
