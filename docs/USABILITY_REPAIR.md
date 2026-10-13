# FastWrite 最低可用性修复与验收

日期：2026-10-13。修复分支：`codex/fastwrite-minimum-usability`，基于 GitHub main `e1d794de88355e715976474e6fa36a26ece29a30`。

## 已修复

### 导入后创建者无法访问论文

目录导入和 GitHub 导入在登记项目的同一数据库事务中创建 private owner 和 owner 成员，避免上传成功后产生无归属稿件。上传会话由当前认证用户拥有，读取、上传、完成和取消都验证所属用户。重复或并发完成请求返回同一个项目，避免网络重试导致重复导入。

旧的无归属上传会话拒绝被普通账号认领，需要重新导入。此前无归属项目没有自动分配、删除或迁移。

### 源码导出返回 401

导出改用现有认证请求，复用登录令牌、401 刷新及 API 错误解析。工作区顶部新增 Export source；顶部和设置里的导出都会先等待编辑器保存完成。下载保留服务器文件名，错误页面和空响应不再冒充压缩包；权限不足或登录失效会明确显示错误。

同类问题一并修复：二进制编译资源、图片预览和 provenance 导出都使用认证 API。图片预览使用 Blob URL，切换图片或关闭预览时清理 URL；CSP 仅对图片增加 `blob:` 支持。

### 首屏长时间白屏

Vite 显式拆分编辑器依赖，首页和项目列表不再预加载 Monaco、PDF 或 LaTeX 引擎。构建检查首页及项目列表的实际静态依赖闭包，防止重新引入重型依赖。

HTML 在 JavaScript 下载前即可显示加载状态，入口或懒加载资源失败时提供重试。构建生成 gzip 资源，服务器正确处理 Accept-Encoding、HEAD、Vary 和缓存。SW 导航优先取网络最新版，只对导航使用离线 HTML，失败脚本不会被 HTML 冒充；API 和认证请求不进入公共缓存。

基路径支持覆盖普通导航、API、认证刷新、链接、协作 socket 及编译器本地资源，可用于 `/` 或线上使用的 `/write/`。

### 基本界面

源码导出放到工作区顶部，默认 AI 面板由 322 px 调整为 280 px，编辑字号由 13 px 调整为 14 px。已有用户保存的面板尺寸保持有效。本次没有进行全站翻译或整体视觉重做。

## 验收结果

| 检查 | 结果 |
|---|---|
| 认证导入、会话隔离、并发与幂等、源码下载、资源认证、gzip、SW、基路径专项 | 36 项通过，183 次断言 |
| CSP 图片 Blob 兼容 | 单独回归通过 |
| 全工作区 TypeScript | 通过 |
| Web 生产构建 `/write/` | 通过，构建检查确认首屏无编辑器依赖 |
| 既有 application API 回归 | 78 项获得通过记录；历史恢复首遍触发本机 5 秒超时，20 秒上限单独复跑通过 |
| Playwright + Microsoft Edge，`/write/` 首屏及加载失败恢复 | 通过，首页/项目列表均未请求 Monaco、PDF 或 LaTeX 引擎 |
| Playwright + Microsoft Edge，真实认证完整论文流程 | 下列 8 项全部通过；页面异常和 API 错误均为 0 |

浏览器完整流程使用开启认证的独立本地服务和 `/write/` 反向代理，真实调用修复后的服务器，使用本机 MiKTeX 编译，未拦截项目、上传、导出或编译 API：

1. 注册并进入个人工作区。
2. 导入 main.tex、section.tex、refs.bib、figure.png，创建者能在列表找到、打开并编译稿件。
3. 认证图片预览成功。
4. 输入后立即导出，压缩包包含最新修改，图片字节完整。
5. 刷新恢复正文，PDF 预览和下载成功。
6. 另一个账号访问该私有稿件返回 403。
7. 加入未定义 LaTeX 命令，错误可见；修正后编译成功。
8. 导出的源码重新导入后仍可编译。

首屏本地测量约 565 ms / 962 ms，仅用于证明依赖拆分及本地行为，不是线上速度承诺。对照构建仅关闭显式拆分设置，就重新出现 Monaco 首屏预加载，确认了原故障原因。

## 可复跑入口

- `scripts/e2e-minimum-usability.mjs`：完整真实流程，只允许 localhost/127.0.0.1，避免误写线上。
- `scripts/e2e-startup.mjs`：首屏资源、HTML 提前可见和失败后的重试。
- `docs/STARTUP_VALIDATION.md`：打包图、缓存和资源检查说明。

脚本使用 Playwright Edge。可设置 `FASTWRITE_E2E_URL`、`FASTWRITE_E2E_OUTPUT` 和 `FASTWRITE_E2E_EXECUTABLE`；完整流程的服务器需启用 `FASTWRITE_SERVER_AUTH=true` 并使用独立 `FASTWRITE_DATA_DIR`。

本机需要把 MiKTeX 与 Perl 加入测试进程 PATH。Git 附带的 MSYS Perl 与原生 MiKTeX 的 BibTeX 路径格式不同，本轮仅在本地测试进程设置 `BIBINPUTS=../source;`、`BSTINPUTS=../source;` 指向每个编译快照的相邻源码目录，没有修改机器全局配置或产品编译逻辑。

## 证据与交付边界

当前任务证据在上层 `../fixed-e2e-v7/`：`result.json`、`01-imported.png`、`02-compile-error.png`、`03-recovered.png`、`paper.pdf`、`source.tar.gz`。首屏 `/write/` 证据在 `../startup-write-validation/`。这些数据不是源码提交的一部分。

前期验证还遇到一个既有 Web 控件规范测试失败，来自未修改的 SourceControlView 原生 button 和 ResearchDialog 原生 label/input。本轮专项测试、类型检查、构建与真实流程均通过；没有宣称全套仓库测试或 GitHub CI 全绿。

源码仓库原有 FastCAS 本地 SDK 依赖需要外置 sibling checkout 并构建其 dist，本轮在隔离目录内准备了该依赖，未修改包版本、锁文件或全局安装。

本次交付仅用于 PR 审阅，不部署。真实会议模板、中文 XeLaTeX、长文与大图、双账号同时编辑和真实模型响应尚未在本轮重新验收。
