# 评测端开发规则

完整 NSOJ 工作区先读 [根目录规则](../AGENTS.md) 和 [评测技术设计](../docs/features/submissions/local-judge.md)。本仓负责评测任务消费与受限执行，后端负责成绩持久化和用户权限。新增或修改评测功能同步更新文档与测试。

- 修改题型、语言、判题器、任务或进度协议时检查后端发送方和前端结果消费者。核对错误与取消路径下的文件和工作目录清理。
- 按 [CI](.github/workflows/ci.yml) 在 Linux 使用其 Node 版本、子模块与 `libfmt-dev`，安装后顺序运行 `CI=true yarn test`、`CI=true yarn lint`、`CI=true yarn check-style`。其中 `yarn test` 执行类型检查。链路验证使用隔离的 Linux 评测实例及 [部署依赖](README.md)。
