# 第三方组件

Squad Voice 的 MIT 许可证适用于项目自身源码。依赖版本由 `ui/pnpm-lock.yaml`、`server/go.mod` 和构建脚本固定。

Windows 包包含 WebView2 SDK 的再分发文件，许可证和通知随包安装。界面依赖的许可由构建输出的 `app/.vite/license.md` 记录。 [Microsoft WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)

增强降噪使用 `@sapphi-red/web-noise-suppressor` 的 MIT 许可封装。包内的 RNNoise 使用 BSD 3-Clause 许可证，Shiguredo 的 WebAssembly 封装使用 Apache-2.0 许可证。这两份许可随安装包放在 `app/licenses`。 [RNNoise](https://github.com/xiph/rnnoise) · [Shiguredo RNNoise WASM](https://github.com/shiguredo/rnnoise-wasm) · [Web Audio 降噪封装](https://github.com/sapphi-red/web-noise-suppressor)

容器包含 Go 模块以及 LiveKit、Caddy、Debian 系统组件，按相应上游许可分发。镜像在 `/usr/local/share/licenses` 附带本项目、Go 模块、LiveKit 或 Caddy 的许可文本。 [LiveKit](https://github.com/livekit/livekit) · [Caddy](https://github.com/caddyserver/caddy)

部署时可单独提供 DB-IP Country Lite 数据。该数据采用 CC BY 4.0。 [DB-IP Country Lite](https://db-ip.com/db/lite.php) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
