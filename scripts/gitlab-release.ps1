# 手动发布：打包产物上传到 GitLab Generic Packages + 挂 Release 资产
# 用法（令牌三种来源，按优先级：-Token 参数 > 环境变量 > 本地文件）：
#   方式一：powershell -ExecutionPolicy Bypass -File scripts/gitlab-release.ps1 -Token "令牌"
#   方式二：$env:GITLAB_TOKEN = "令牌"; powershell ... -File scripts/gitlab-release.ps1
#   方式三（推荐，填一次永久生效）：先执行 scripts/set-release-token.ps1 配置本地令牌
#          （保存到 scripts/.release-token，已被 .gitignore 排除，不进仓库）
#
# 为什么用 Generic Packages 而不是 uploads：
#   私有项目下 uploads 文件下载会 302 到登录页（token 不生效），
#   Generic Packages 是 API 路径，客户端带 PRIVATE-TOKEN header 可完整下载。
#
# 脚本自动完成：
#   1. 从 package.json 读取版本号（如 0.1.5），tag 定为 v0.1.5
#   2. 检查 GitLab 上 tag 是否存在，不存在则自动创建（指向 main）
#   3. 上传 release/ 下的安装包到 Generic Packages
#   4. 创建/更新 Release，并把 Generic Packages 下载地址挂为资产链接
# 前置条件：先执行 npm run dist:win 生成 release/*.exe
param(
  [string]$Token = $env:GITLAB_TOKEN,
  [string]$ApiUrl = "http://47.114.48.201:9000/api/v4",
  # 注意：Generic Packages API 只接受数字项目 ID（path 编码会 400）
  [string]$ProjectId = "157",
  [string]$PackageName = "product-image-downloader"
)
$ErrorActionPreference = 'Stop'

# 令牌解析：-Token 参数 > 环境变量 GITLAB_TOKEN > 本地文件 scripts/.release-token
if (-not $Token) {
  $tokenFile = Join-Path $PSScriptRoot '.release-token'
  if (Test-Path $tokenFile) {
    $Token = (Get-Content $tokenFile -Raw).Trim()
    Write-Output "已从本地文件读取令牌 ($tokenFile)"
  }
}
if (-not $Token) {
  throw '缺少访问令牌：请先执行 scripts/set-release-token.ps1 配置本地令牌，或设置 $env:GITLAB_TOKEN / -Token 参数'
}

# 1. 从 package.json 读取版本
$pkg = Get-Content -Raw package.json | ConvertFrom-Json
$version = $pkg.version
if (-not $version) {
  throw '无法从 package.json 读取版本号'
}
$tag = "v$version"
$headers = @{ 'PRIVATE-TOKEN' = $Token }
$proj = [uri]::EscapeDataString($ProjectId)
Write-Output "版本: $version，tag: $tag"

# 2. 确保 tag 存在（不存在则自动创建，指向 main）
try {
  Invoke-RestMethod -Uri "$ApiUrl/projects/$proj/repository/tags/$tag" -Headers $headers -TimeoutSec 15 | Out-Null
  Write-Output "tag 已存在: $tag"
} catch {
  Write-Output "tag 不存在，创建: $tag (指向 main)"
  $tagBody = @{ tag_name = $tag; ref = 'main'; message = "Release $tag" } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$ApiUrl/projects/$proj/repository/tags" -Headers $headers -ContentType 'application/json' -Body $tagBody -TimeoutSec 15 | Out-Null
}

# 3. 找到与当前版本匹配的安装包（避免误传旧版本）
$expectedName = "product-image-downloader-setup-$version.exe"
$setup = Get-ChildItem -Path 'release' -Filter "*.exe" | Where-Object { $_.Name -eq $expectedName } | Select-Object -First 1
if (-not $setup) {
  Write-Output "未找到 $expectedName，列出现有安装包："
  Get-ChildItem -Path 'release' -Filter "*.exe" | ForEach-Object { Write-Output "  $($_.Name)" }
  throw "release/ 目录下没有与当前版本 ($version) 匹配的安装包，请先执行 npm run dist:win"
}
Write-Output "安装包: $($setup.Name) ($($setup.Length) bytes)"

# 4. 上传到 Generic Packages（PUT 方式，幂等：同版本同名文件重复上传会覆盖）
$pkgVer = $version
$pkgPath = "$ApiUrl/projects/$proj/packages/generic/$PackageName/$pkgVer/$($setup.Name)"
$uploadStatus = curl.exe -s -X PUT -H "PRIVATE-TOKEN: $Token" --data-binary "@$($setup.FullName)" -o NUL -w "%{http_code}" $pkgPath
if ($uploadStatus -ne '201' -and $uploadStatus -ne '200') {
  throw "Generic Packages 上传失败 (HTTP $uploadStatus)"
}
$downloadUrl = $pkgPath
Write-Output "已上传: $downloadUrl"

# 5. 创建/更新 Release
$releaseBody = @{
  name        = $tag
  tag_name    = $tag
  description = "手动发布 $tag"
} | ConvertTo-Json

try {
  $release = Invoke-RestMethod -Method Post -Uri "$ApiUrl/projects/$proj/releases" -Headers $headers -ContentType 'application/json' -Body $releaseBody -TimeoutSec 15
  Write-Output "Release 已创建: $($release.tag_name)"
} catch {
  $release = Invoke-RestMethod -Method Put -Uri "$ApiUrl/projects/$proj/releases/$tag" -Headers $headers -ContentType 'application/json' -Body $releaseBody -TimeoutSec 15
  Write-Output "Release 已更新: $($release.tag_name)"
}

# 6. 挂安装包资产链接（幂等：已存在同名链接则跳过）
$existing = Invoke-RestMethod -Uri "$ApiUrl/projects/$proj/releases/$tag/assets/links" -Headers $headers -TimeoutSec 15
if ($existing.name -notcontains $setup.Name) {
  $linkBody = @{
    name      = $setup.Name
    url       = $downloadUrl
    link_type = 'package'
  } | ConvertTo-Json
  $link = Invoke-RestMethod -Method Post -Uri "$ApiUrl/projects/$proj/releases/$tag/assets/links" -Headers $headers -ContentType 'application/json' -Body $linkBody -TimeoutSec 15
  Write-Output "资产链接: $($link.name)"
} else {
  Write-Output "资产链接已存在，跳过"
}

Write-Output "发布完成: $ApiUrl/projects/$proj/releases/$tag"
