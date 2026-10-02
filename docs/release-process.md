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

5. `Release`工作流核对标签、版本、发布说明、主分支归属和CI结果，再创建GitHub Release。核对发布页存在且对应正确标签。

不移动已发布标签。需要修复时发布新patch版本。发Release不会自动部署服务器；部署按版本说明进行备份、迁移和验证。
