# 版本发布

正式版本对应一个不可移动的Git标签和GitHub Release；日常提交留在Unreleased。

1. 在分支实现改动，更新`package.json`版本、`CHANGELOG.md`和`docs/releases/vX.Y.Z.md`。
2. 创建PR，通过CI、数据库升级与冒烟检查，再合并主分支。
3. 等待合并提交的push CI成功，核对主分支提交。
4. 对该提交创建并推送标签：

   ```bash
   git tag -a vX.Y.Z <已验证的主分支提交> -m '见微 vX.Y.Z'
   git push origin vX.Y.Z
   ```

5. `Release`工作流核对标签、版本、发布说明、主分支归属和CI结果，再构建并推送 Web、Worker、迁移工具和 WeRSS 的 `linux/amd64` / `linux/arm64` 版本镜像。所有镜像成功后才创建 GitHub Release，核对发布页和镜像标签对应同一提交。

镜像名为 `ghcr.io/workagi/jianwei-{web,worker,migrate,werss}:vX.Y.Z`，不使用浮动 `latest`。首次发布时检查 GHCR 四个包的可见性：公共安装需将包设置为 Public；私有安装需授权 `docker login ghcr.io`。首次发布前，仓库存在工作流不代表镜像已经可拉取。

确认版本镜像可访问后，本机 `.env` 设置 `JIANWEI_IMAGE_TAG=vX.Y.Z` 即可由 `./start.sh` 拉取部署。生产使用 `docker-compose.prod.yml` 和 `docker-compose.images.yml` 的组合，具体命令见 [生产部署](production-deploy.md)。版本镜像从 v0.3.0 开始发布；每次发布都需核对工作流成功与目标架构镜像可拉取。

不移动已发布标签。需要修复时发布新patch版本。发Release不会自动部署服务器；部署按版本说明进行备份、迁移和验证。

精简 Worker 不包含维护脚本；在数据库已启动时使用一次性 `migrate` 工具容器：

```bash
docker compose run --rm --no-deps migrate pnpm model:receipts list
docker compose run --rm --no-deps migrate pnpm model:receipts retry <receipt-key>
```

生产或版本镜像部署时，沿用启动时的 `--env-file`、`-p` 和 `-f` 参数。`retry` 只放行超过 30 分钟、结果不明的回执；再次处理可能产生新的服务商费用。
