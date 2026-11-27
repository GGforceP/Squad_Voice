# Squad Voice 服务端接入约定

这是 Windows 客户端和 [Docker Compose 服务端](server/README.md) 的接口。正式地址由房主在首次启动时配置。HTTPS API 和 WSS 信令由同一 TLS 入口接入。地址使用根路径，配置中只填写 HTTPS origin。

## 登录

POST /api/v1/login

请求：用户名 username 和管理员分配的 password。服务端验证账号状态、密码哈希并限制尝试频率；不提供注册。成功返回：

~~~json
{
  "sessionToken": "<opaque session token>",
  "user": {"id": "member-01", "username": "member01", "name": "成员显示名", "bio": "", "admin": true},
  "workspace": {
    "name": "小队名称",
    "channels": [
      {"id": "voice-lobby", "name": "开黑大厅", "description": "自由聊天", "capacity": 5}
    ]
  }
}
~~~

会话令牌由 Windows 宿主通过 Authorization: Bearer 发送；客户端不写入磁盘、不交给网页存储。用户和频道 id 用最多 64 位 ASCII 字母、数字、下划线或连字符。可见名称最长 64 个字符。拒绝凭据用 401/403，频率限制用 429。响应建议附带 Cache-Control: no-store。

## 进入频道

POST /api/v1/voice/join，带会话令牌；请求 JSON 包含 channelId。由服务端验证频道访问权、按房间限制五人，再签发短期 LiveKit 令牌。成功返回：

~~~json
{
  "serverUrl": "wss://voice.example.invalid",
  "accessToken": "<short-lived, room-scoped media token>",
  "leaseId": "<current voice reservation>"
}
~~~

允许订阅音频。发布权限只授予 microphone 和 screen_share_audio（后者承载单独的伴奏音轨，不开启屏幕视频）。房间上限也应写入 LiveKit 房间配置；满员用 409，过期会话 401，禁止进入 403。签发密钥始终只在服务端。首次五人版本计划同一房间一条伴奏；若服务端需严格保证，应将伴奏权限与服务端持有者状态联动。不要把客户端的防重提示当作服务端权限约束。

## 个人资料与改密

三个接口均使用 POST 和登录会话令牌。

- `/api/v1/account/me` 返回当前成员的 `id`、`username`、`name` 和 `bio`。
- `/api/v1/account/profile` 接收 `name` 和 `bio`，返回修改后的成员资料。
- `/api/v1/account/password` 接收 `currentPassword` 和 `newPassword`，成功返回 204 并撤销现有会话和语音许可。新密码须为 9–128 个字符，并使用大写字母、小写字母、数字、符号四类中的至少两类。登录名由房主维护。

业务入口检查真实连接 IP。地域拒绝返回 403，并附带 `X-SquadVoice-Error: region_not_allowed`。API 其它错误使用相同的错误头和 JSON `code`。

## 频道状态和聊天

- `POST /api/v1/workspace` 返回 `groups`、子频道列表、成员目录 `people` 和 LiveKit 实际入房的成员状态。频道的 `groupId` 指向母频道。旧配置中的语音频道沿用原 ID 并归入默认母频道。
- `POST /api/v1/group/{create,update,delete}` 供总管理和递归管理维护母频道。删除母频道时同时移除其中的子频道和聊天。
- `POST /api/v1/channel/{create,update,delete}` 维护子频道，容量为 1–5 人。创建时提供 `groupId`，旧客户端可省略。频道管理员可以在获授权的母频道内创建子频道，并编辑或删除其管理范围内的子频道。
- `POST /api/v1/chat/history` 使用 `channelId`、`limit` 和可选的 `before` 或 `after` 消息 ID 分页。`known` 是客户端已保存的页面校验值，相同时服务端返回 `unchanged`。
- `POST /api/v1/chat/send` 接收消息文字和客户端 `nonce`。`POST /api/v1/chat/upload?channel=<id>` 接收 multipart `nonce`、可选 `text` 和 `image`。`POST /api/v1/chat/image` 按 `channelId` 和 `id` 获取图片。客户端有缓存时可传 `known: "cached"`，服务端确认图片仍有效后返回 204。
- 频道聊天与图片按当前语音入房校验，未入房返回 `join_voice_for_chat`。`POST /api/v1/chat/delete` 按 `channelId` 和 `id` 删除频道消息，要求该频道的管理员权限。
- 成员目录中的 `conversationId` 可用于双方私信的 `channelId` 或上传接口的 `channel`。服务端检查登录账号属于这对会话参与者，并校验对方账号状态。
- `POST /api/v1/chat/watch` 用 `epoch` 和 `cursor` 长轮询变化。频道消息通知随当前语音频道发送。私信的消息和缓存事件只送达会话双方。事件过旧或数据世代变更时返回 `reset`，客户端清除聊天缓存后重新按需加载。

`workspace` 中的 `role` 和成员 `role` 使用 `owner`、`recursive`、`channel`、`member`。`managedChannels` 列出此账号有权管理的频道。语音成员的 `rules` 可带 `listenUntil`、`micUntil`、`chatUntil`。它们是允许自助解除的 Unix 毫秒时间戳，存在时一直限制，直至有人解除。

`POST /api/v1/member/control` 接收 `channelId`、成员的语音 `targetId`、`action` 和 `enabled`。操作值为 `listen`、`mic`、`chat`、`channel-admin`、`recursive-admin`。本人解除时省略 `targetId`，发送 `enabled: false`。60 秒内返回 `restriction_locked`。禁言时文字发送和图片上传返回 `chat_restricted`。

## Windows 更新分发

两条接口要求登录并通过地域准入。`POST /api/v1/client/update` 返回带 `payload` 和 `signature` 的签名清单。更新关闭或尚未发布时返回 204。`POST /api/v1/client/download` 用签名清单的 `version` 和 `sha256` 读取该安装包。发布在下载前变更时返回 `update_changed`。客户端只接受版本高于自身、签名有效且大小和散列一致的安装包。

## 退出

`POST /api/v1/voice/leave` 带会话令牌和对应的 `leaseId`，释放该次语音连接。 `POST /api/v1/logout` 带会话令牌，撤销会话及其语音许可。两者成功返回 204。

## 实际接入前

部署者需验证 HTTPS/WSS 证书信任、媒体端口可达性与峰值出站带宽。客户端默认采用单声道 Opus，语音目标 24 kbps，伴奏目标 48 kbps。实际出站流量随同时发布的音轨和订阅人数变化。
