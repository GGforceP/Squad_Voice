# Squad Voice

自托管小队语音应用，包含 Windows x64 客户端和 Linux amd64 Docker 服务端。支持邀请账号、语音与进程伴奏、频道聊天、分级管理和本地加密缓存。单套服务最多支持五人同时通话。

## 安装与使用

从 GitHub Releases 获取 Windows x64 安装包。需要 .NET Framework 4.8 和 Microsoft Edge WebView2 Evergreen Runtime。打开「接入配置」，输入房主提供的 HTTPS 地址，再使用房主分配的账号登录。 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

选择频道可预览语音成员。加入频道后可收发文字、表情和单张不超过 5 MB 的图片。拖动分隔线可调整语音和聊天高度，双击图片可查看大图。右侧成员列表提供管理员操作，静音、闭麦与禁言分别控制收听、麦克风和发送消息。

客户端可跟随 Windows 音频设备，支持按住说话、麦克风测试和降噪。通话中可共享所选应用进程的伴奏。窗口关闭按钮收至通知区域，要退出程序时使用托盘菜单。

Windows 文档目录下的 `Squad Voice` 保存安装位置和偏好。安装目录的 `Data` 保存 DPAPI 保护的连接资料、可选的登录记忆和聊天缓存。通过「设置 → 缓存管理」可以查看用量、迁移或清理缓存。升级时选择原安装目录。卸载可使用安装目录内的 `Uninstall.exe`。

## 自托管

使用 Docker Compose 部署 Go 服务、LiveKit 和 Caddy。部署者准备公网访问、HTTPS 入口和账号，并选择允许的国家或地区。证书、发布公钥和媒体签发密钥由部署者配置。 [Docker 部署](server/README.md) · [客户端接口](SERVER-CONTRACT.md)

## 构建 Windows 客户端

在 Windows x64 使用 PowerShell 7、Node.js 24 和 pnpm 11。构建脚本使用 Windows 的 .NET Framework 编译器，并下载校验过的 WebView2 SDK 与 NSIS。

~~~powershell
./scripts/Get-BuildDeps.ps1 -SkipLiveKit
./scripts/Build-Windows.ps1 -ArtifactDirectory './dist'
~~~

需要联调时用 `Get-BuildDeps.ps1` 下载测试用 LiveKit，用 `Build-Windows.ps1 -QA` 生成独立测试构建。测试脚本使用合成麦克风和临时登录资料。

## 发布分支

| 分支 | 产物 |
| --- | --- |
| `installer`，默认分支 | Windows x64 GitHub Release 安装包与 SHA-256 |
| `docker` | GHCR 的 `backend`、`media` 和 `edge` 三个镜像 |

两条分支保留完整源码，版本由根目录的 `VERSION` 管理。 [发布流程](RELEASING.md)

项目源码采用 MIT 许可证，依赖按各自的许可分发。 [MIT 许可证](LICENSE) · [第三方组件](THIRD_PARTY.md)
