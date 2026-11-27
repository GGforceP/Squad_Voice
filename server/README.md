# Squad Voice Docker 服务端

Linux amd64 部署包含 Go 后端、LiveKit 媒体服务和 Caddy HTTPS 入口。可以用自构建镜像，也可以使用项目发布的容器镜像。

## 准备与启动

1. 安装 Docker Engine 与 Compose。将 `.env.example` 复制为 `.env`，填写自己的域名或公网 IPv4、公网 IPv4 和总管理账号名称。使用域名时，让 DNS 记录指向可访问的入口并保留客户端来源 IP。公网 IPv4 直接接入时，域名设置和公网 IPv4 设置填同一地址，使用 `shortlived` 证书配置。
2. 选择发布镜像时，将 `SQUADVOICE_IMAGE_PREFIX` 填为 `ghcr.io/<所有者>/<仓库>`，将 `SQUADVOICE_IMAGE_TAG` 填为发布版本。以下命令在 `server` 目录运行。

~~~sh
cp .env.example .env
# 编辑 .env 后拉取镜像。
docker compose -f compose.yaml -f compose.public.yaml --profile public pull
~~~

从源码构建时使用示例中的本地镜像名，并从项目根目录构建上下文。Compose 覆盖文件已设好上下文。

~~~sh
sh deploy/fetch-deps.sh
docker compose -f compose.yaml -f compose.build.yaml --profile public build
~~~

Go 模块下载受限时，可在能访问 Go 模块源的主机从 `server` 目录运行 `go mod vendor`，将其生成的依赖目录用于本地构建。

将当月 DB-IP Country Lite CSV gzip 下载到部署目录之外。将下面命令中的文件路径、年月和两位国家或地区代码替换为本次部署的值。初始化会在运行主机上生成媒体签发密钥和地域规则。 [DB-IP Country Lite](https://db-ip.com/db/lite.php)

~~~sh
sudo sh deploy/initialize.sh /path/to/dbip-country-lite-YYYY-MM.csv.gz YYYY-MM XX
docker compose -f compose.yaml -f compose.public.yaml --profile public up -d --wait
docker compose exec backend /squadvoice admin status
~~~

| 入方向 | 用途 |
| --- | --- |
| TCP 80 | ACME 校验和 HTTP 重定向 |
| TCP 443 | HTTPS API 和 WSS 信令 |
| UDP 7882 | WebRTC 媒体 |
| TCP 7881 | ICE/TCP 备用媒体通道 |

Caddy 自动申请和续期证书，证书状态在 `certificates` 卷中。LiveKit 管理接口仅对容器网络空间中的环回地址开放。HTTPS、WSS 和媒体使用初始化时选定的地域数据。 [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https) · [LiveKit 媒体端口](https://docs.livekit.io/transport/self-hosting/ports-firewall/)

更新地域数据时，重新执行初始化后重启后端和媒体服务，使两者加载同一份数据。容器根据连接来源 IP 进行判断。

## 账号与频道

以有权操作 Docker 的部署者身份运行下列命令。开户和重置密码时在终端隐藏输入。总管理由 `SQUADVOICE_OWNER` 绑定到登录名，先配置登录名，再建立对应账号。

~~~sh
docker compose exec backend /squadvoice admin account add owner '房主'
docker compose exec backend /squadvoice admin account add member1 '小队成员'
docker compose exec backend /squadvoice admin account list
docker compose exec backend /squadvoice admin account passwd member1
docker compose exec backend /squadvoice admin workspace rename '我的小队'
docker compose exec backend /squadvoice admin channel set voice-lobby '语音频道' 5 '语音与伴奏'
~~~

`admin account admin|member USER` 管理全局递归权限。`account enable|disable|delete USER` 管理账号状态。已加入频道的管理员可以在客户端对成员应用收听、麦克风或消息限制。成员等满 60 秒可以自行解除，管理者可以提前解除。频道管理权限只在被授予的频道生效。

0.6.0 使用大频道和子频道。已有子频道登录后会显示在默认大频道中，频道 ID 和聊天记录随服务端数据卷保留。上线升级前备份 `accounts` 卷。回退到旧服务端镜像时，通过该备份恢复与旧版对应的状态和媒体数据。

账号、频道与聊天在 `accounts` 卷。容器 `/data/mediacache` 保存聊天数据库与图片。`cachesize` 以 MiB 设置图片占用上限，默认 10240。达到配额时先清理最早的图片，保留对应文字和消息记录。备份或迁移时应保留使用中的数据卷和运行配置。

## 签名在线更新

启用时，发布者生成自己的 RSA-3072 公钥和 DPAPI 加密私钥，将公钥写入服务端可读的 `config/update-key.json`，并用客户端构建参数 `-UpdatePublicKey` 提供同一份公钥。将 `ClientUdtCHK` 设置为 `true`，创建 `Client-Installer`，再用 `compose.updates.yaml` 将该目录只读挂载为容器 `/Client-Installer`。

~~~powershell
./scripts/Publish-WindowsUpdate.ps1 -Initialize -KeyPath '<私钥文件>' -PublicKeyPath '<公钥文件>'
./scripts/Build-Windows.ps1 -UpdatePublicKey '<公钥文件>' -ArtifactDirectory './dist'
./scripts/Publish-WindowsUpdate.ps1 -KeyPath '<私钥文件>' -PublicKeyPath '<公钥文件>' -Installer '<安装包路径>' -OutputDirectory '<输出目录>'
~~~

先放入安装包，再替换配套的 `release.json`。使用 `-Required` 标记退出时确认安装的版本。签名清单绑定平台、版本、大小和 SHA-256，客户端重新校验后启动安装器。签名私钥保存在发布者本机。

~~~sh
mkdir -p Client-Installer
docker compose -f compose.yaml -f compose.public.yaml -f compose.updates.yaml --profile public up -d --wait
~~~
