# 上传打包产物到 GitLab Release
# 使用环境变量（由 GitLab CI 提供）：
#   CI_API_V4_URL  — API 基础地址，如 http://host/api/v4
#   CI_PROJECT_ID  — 项目 ID
#   CI_COMMIT_TAG  — 触发本任务的 tag（如 v0.1.5）
#   GITLAB_TOKEN   — 个人访问令牌（api 权限）
$ErrorActionPreference = 'Stop'

$api = $env:CI_API_V4_URL
$projectId = $env:CI_PROJECT_ID
$tag = $env:CI_COMMIT_TAG
$token = $env:GITLAB_TOKEN

if (-not $api -or -not $projectId -or -not $tag -or -not $token) {
  throw '缺少 CI 环境变量（CI_API_V4_URL / CI_PROJECT_ID / CI_COMMIT_TAG / GITLAB_TOKEN）'
}

$version = $tag.TrimStart('v')
$headers = @{ 'PRIVATE-TOKEN' = $token }

# 1. 找到安装包
$setup = Get-ChildItem -Path 'release' -Filter "*.exe" | Where-Object { $_.Name -notlike '*.blockmap*' } | Select-Object -First 1
if (-not $setup) {
  throw 'release/ 目录下没有找到安装包'
}
Write-Output "安装包: $($setup.Name) ($($setup.Length) bytes)"

# 2. 上传文件到项目 uploads（返回相对 URL，如 /tools/project/uploads/hash/file.exe）
$uploadJson = curl.exe -s -X POST -H "PRIVATE-TOKEN: $token" -F "file=@$($setup.FullName)" "$api/projects/$projectId/uploads"
$upload = $uploadJson | ConvertFrom-Json
if (-not $upload.url) {
  throw "上传失败: $uploadJson"
}
$downloadUrl = "$($env:CI_SERVER_URL)$($upload.url)"
Write-Output "已上传: $downloadUrl"

# 3. 创建 Release（tag 已存在；若已存在则更新）
$releaseBody = @{
  name        = "v$version"
  tag_name    = $tag
  description = "自动打包构建 v$version"
} | ConvertTo-Json

$release = $null
try {
  $release = Invoke-RestMethod -Method Post -Uri "$api/projects/$projectId/releases" -Headers $headers -ContentType 'application/json' -Body $releaseBody
} catch {
  $release = Invoke-RestMethod -Method Put -Uri "$api/projects/$projectId/releases/$tag" -Headers $headers -ContentType 'application/json' -Body $releaseBody
}
Write-Output "Release: $($release.tag_name)"

# 4. 添加安装包为资产链接（幂等：已存在同名链接则跳过）
$existing = Invoke-RestMethod -Uri "$api/projects/$projectId/releases/$tag/assets/links" -Headers $headers
if ($existing.name -notcontains $setup.Name) {
  $linkBody = @{
    name = $setup.Name
    url  = $downloadUrl
    link_type = 'package'
  } | ConvertTo-Json
  $link = Invoke-RestMethod -Method Post -Uri "$api/projects/$projectId/releases/$tag/assets/links" -Headers $headers -ContentType 'application/json' -Body $linkBody
  Write-Output "资产链接: $($link.name)"
} else {
  Write-Output "资产链接已存在，跳过"
}

Write-Output "完成"
