#requires -Version 5.1
# Claude 로그인 스크립트. 클로드로그인.bat 이 이 파일을 호출한다.

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Set-Location -LiteralPath $PSScriptRoot
$Host.UI.RawUI.WindowTitle = 'Claude 로그인'

# 방금 설치한 CLI 가 기존 창의 PATH 에 없어서 "인식되지 않습니다" 가 뜨는 걸 막는다.
$npmGlobal = Join-Path $env:APPDATA 'npm'
if (Test-Path $npmGlobal) { $env:Path = "$npmGlobal;$env:Path" }

function Pause-Exit([int]$code = 0) {
    Write-Host ''
    Read-Host '창을 닫으려면 Enter 를 누르세요'
    exit $code
}

Write-Host ''
Write-Host '  ===========================================' -ForegroundColor DarkGray
Write-Host '   Claude 로그인' -ForegroundColor Cyan
Write-Host '  ===========================================' -ForegroundColor DarkGray
Write-Host ''

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host '  [오류] Node.js 를 찾을 수 없습니다.' -ForegroundColor Red
    Write-Host '         https://nodejs.org 에서 설치한 뒤 다시 실행하세요.'
    Pause-Exit 1
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host '  Claude CLI 가 없어서 먼저 설치합니다. 1~2분 걸립니다...' -ForegroundColor Yellow
    Write-Host ''
    & npm install -g '@anthropic-ai/claude-code'
    Write-Host ''
    if (Test-Path $npmGlobal) { $env:Path = "$npmGlobal;$env:Path" }
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host '  [오류] 설치했는데도 claude 명령을 찾지 못했습니다.' -ForegroundColor Red
    Write-Host '         이 창의 내용을 그대로 복사해서 알려주세요.'
    Pause-Exit 1
}

Write-Host '  현재 상태:'
try { & claude auth status } catch { Write-Host "  (상태 확인 실패: $_)" -ForegroundColor DarkYellow }

Write-Host ''
Write-Host '  -------------------------------------------' -ForegroundColor DarkGray
Write-Host '   브라우저가 열리면 로그인해 주세요.'
Write-Host '   창이 안 열리면 아래에 표시되는 주소를'
Write-Host '   브라우저 주소창에 직접 붙여넣으세요.'
Write-Host '  -------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

try {
    & claude auth login
} catch {
    Write-Host ''
    Write-Host "  [오류] 로그인 중 문제가 발생했습니다: $_" -ForegroundColor Red
}

Write-Host ''
Write-Host '  로그인 후 상태:'
try { & claude auth status } catch { Write-Host "  (상태 확인 실패: $_)" -ForegroundColor DarkYellow }

Write-Host ''
Write-Host '  loggedIn 이 true 면 성공입니다.' -ForegroundColor Green
Write-Host '  앱 설정 → 모델 설정 → 생성 엔진에서 Claude 를 고르면 됩니다.'
Pause-Exit 0
