# 验证 GitLab 令牌是否满足客户端更新所需权限（read_api 是否够用）
# 用法（token 只在你自己命令行里，不会出现在任何输出中）：
#   powershell -ExecutionPolicy Bypass -File scripts/verify-gitlab-token.ps1
#   （脚本会读取环境变量 GITLAB_READ_TOKEN；也可用 -Token 参数传入）
#
# 验证内容：
#   1. 查询最新 Release（GET /projects/:id/releases）
#   2. 下载最新安装包（GET /packages/generic/...）
#   3. 校验下载文件大小是否与本地 release/ 目录的安装包一致
# 输出中不会包含令牌本身。
param(
  [string]$Token = $env:GITLAB_READ_TOKEN,
  [string]$ApiUrl = "http://47.114.48.201:9000/api/v4",
  [string]$ProjectId = "157"
)
$ErrorActionPreference = 'Stop'

if (-not $Token) {
  Write-Host "错误：未提供令牌。请先执行:" -ForegroundColor Red
  Write-Host '  $env:GITLAB_READ_TOKEN = "你的read_api令牌"' -ForegroundColor Yellow
  Write-Host "然后重新运行本脚本。" -ForegroundColor Red
  exit 1
}

Write-Host "=== 1/3 查询最新 Release（只读）===" -ForegroundColor Cyan
$releases = Invoke-RestMethod -Uri "$ApiUrl/projects/$ProjectId/releases?per_page=1" -Headers @{ 'PRIVATE-TOKEN' = $Token } -TimeoutSec 15
$latest = $releases[0]
$version = $latest.tag_name -replace '^v', ''
Write-Host "  最新版本: $version" -ForegroundColor Green

$exe = $latest.assets.links | Where-Object { $_.url -match '\.exe$' } | Select-Object -First 1
if (-not $exe) {
  Write-Host "  错误：最新 Release 没有安装包链接" -ForegroundColor Red
  exit 1
}
Write-Host "  安装包链接: $($exe.url)" -ForegroundColor Green

Write-Host "=== 2/3 下载安装包（只读）===" -ForegroundColor Cyan
$tmpFile = Join-Path $env:TEMP "verify-read-token-$(Get-Random).exe"
curl.exe -s -H "PRIVATE-TOKEN: $Token" -o $tmpFile -w "  HTTP状态: %{http_code}`n" $exe.url | Write-Host
$downloadedSize = (Get-Item $tmpFile).Length
Write-Host "  下载大小: $downloadedSize bytes" -ForegroundColor Green

Write-Host "=== 3/3 与本地安装包比对 ===" -ForegroundColor Cyan
$local = Get-ChildItem -Path 'release' -Filter "product-image-downloader-setup-$version.exe" | Select-Object -First 1
if (-not $local) {
  Write-Host "  本地无 $version 安装包，跳过比对" -ForegroundColor Yellow
} else {
  Write-Host "  本地大小: $($local.Length) bytes" -ForegroundColor Green
  if ($downloadedSize -eq $local.Length) {
    Write-Host "  ✓ 大小一致，read_api 令牌下载成功" -ForegroundColor Green
  } else {
    Write-Host "  ✗ 大小不一致（可能下载到的是登录页或错误页）" -ForegroundColor Red
    exit 1
  }
}

Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
Write-Host "`n=== 结论 ===" -ForegroundColor Cyan
if ($downloadedSize -gt 10000000) {
  Write-Host "✓ read_api 令牌满足客户端更新所需全部权限（查询 + 下载）" -ForegroundColor Green
} else {
  Write-Host "✗ 下载大小异常（$downloadedSize bytes），read_api 可能不够，需要 api 权限" -ForegroundColor Red
}
