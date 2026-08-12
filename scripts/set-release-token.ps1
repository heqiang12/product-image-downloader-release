# 配置本地发版令牌（保存到 scripts/.release-token，已被 .gitignore 排除，不进仓库）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/set-release-token.ps1
# 提示输入令牌时粘贴你的发版令牌（api 权限），回车即保存。
# 之后执行 scripts/gitlab-release.ps1 会自动读取，无需再设置环境变量。
param(
  [string]$Token = $env:GITLAB_TOKEN
)
$ErrorActionPreference = 'Stop'

$tokenFile = Join-Path $PSScriptRoot '.release-token'

if (-not $Token) {
  Write-Host "请输入 GitLab 发版令牌（api 权限，不会显示在屏幕上）：" -ForegroundColor Cyan
  $Token = Read-Host -AsSecureString
  $Token = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
  )
}

if ([string]::IsNullOrWhiteSpace($Token)) {
  Write-Host "未输入令牌，已取消。" -ForegroundColor Yellow
  exit 1
}

# 写入本地文件（UTF-8，无换行）
[System.IO.File]::WriteAllText($tokenFile, $Token.Trim(), (New-Object System.Text.UTF8Encoding $false))
Write-Host "已保存到 $tokenFile（被 .gitignore 排除，不会提交进 Git 仓库）" -ForegroundColor Green
Write-Host "之后执行 npm run release:win 或 scripts/gitlab-release.ps1 会自动读取此令牌。" -ForegroundColor Green
