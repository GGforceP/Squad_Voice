# 发布

`installer` 与 `docker` 使用同一套源码和 `VERSION`。在 GitHub 建立空仓库后，先推送 `installer` 并设为默认分支，再推送 `docker`。

每次发版时，根据客户端和服务端实际新增、调整的功能，分别更新「已实现的功能」清单和对应版本的更新日志。核对清单中的版本号与发布产物一致，并将 README 同步到两个分支。[README](README.md)

推送前在公开工作区检查两个分支可达的 Git 历史。部署主机和本机实际运行产生的配置、数据库、缓存、证书、签名公钥和私钥都存放在发布仓库之外。需要发布更新时从源码重新构建。

~~~sh
node scripts/Check-PublicTree.mjs --worktree
node scripts/Check-PublicTree.mjs installer docker
~~~

本地可启用同一套推送前检查。钩子会扫描即将推送的提交和可达历史。

~~~sh
git config core.hooksPath .githooks
~~

分支推送会触发构建验收。需要发布版本时，在 Actions 选中对应分支运行工作流并勾选 `publish`。

| 工作流 | 分支 | 发布目标 |
| --- | --- | --- |
| Windows installer | `installer` | GitHub Releases 的 `v<版本>`，包含安装包和 SHA-256 |
| Docker images | `docker` | `ghcr.io/<所有者>/<仓库>-backend:<版本>`、`-media:<版本>`、`-edge:<版本>` |

首次发布镜像后，在 GitHub Packages 检查三个包的可见性。设置为 Public 后，可用未登录的 Docker 客户端验证拉取。 [GitHub Packages 可见性](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

公开工作流构建通用安装包。部署者需要通过自托管服务器分发签名更新时，使用自己的公钥构建配套客户端。 [签名发布说明](server/README.md#签名在线更新)
