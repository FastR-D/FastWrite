# FastRead 联动

在项目的「文献与证据」面板生成 FastRead 连接码，将它粘贴到 FastRead 设置中的 FastWrite 连接栏。FastRead 随后可以选择当前用户有写入权限的 FastWrite 项目，同步论文元数据、阅读报告、逐页引文、批注、个人笔记和 BibTeX。

连接码首次生成时显示一次。重新生成会替换旧连接码，撤销连接会立即停止访问。连接记录绑定 FastWrite 用户；每次请求都会检查用户状态和当前项目、路径权限。

## 阅读资料交接

每份资料包保存在 `references/fastread/<bundle_id>/`，其中 `manifest.json`、`citations.json`、`evidence.md`、`references.bib` 和 `user-notes.md` 构成一份独立快照。相同内容重试可以继续完成上传；同一目录出现内容冲突时返回 409，修改后的阅读内容会使用新的资料包目录。

文件写入后沿用研究服务的资料包导入流程，将文献和页码引文加入项目的文献与证据列表。资料包清单遵循现有 FastRead v1 格式。

## 写作反馈

「文献与证据 → 文献 → 连接 FastRead」显示已关联论文。选择论文后编辑写作反馈，保存后即可在 FastRead 中拉取到对应论文的研究笔记。现有证据的审阅状态、引用立场和原文摘录也随反馈返回。

## HTTP 接口

| 接口 | 身份 | 用途 |
| --- | --- | --- |
| `POST /api/integrations/fastread/token` | 用户会话 | 生成或轮换连接码 |
| `GET /api/integrations/fastread/token` | 用户会话或连接码 | 查询连接状态 |
| `DELETE /api/integrations/fastread/token` | 用户会话 | 撤销连接码 |
| `GET /api/integrations/fastread/projects` | Bearer 连接码 | 列出可写项目 |
| `POST /api/integrations/fastread/projects/:id/bundles` | Bearer 连接码 | 上传资料包并导入证据 |
| `GET /api/integrations/fastread/projects/:id/feedback` | Bearer 连接码 | 读取写作反馈 |
| `GET/PUT /api/projects/:projectId/research/fastread-feedback` | 用户会话 | 查看或编辑关联论文反馈 |

上传请求包含 `bundle_id`、`manifest_path` 和 `files: [{path, content}]`。返回 `{ok, bundle_id, receipts}`。反馈返回 `items: [{id, paper_id, title, content}]`，以 FastRead 原论文 ID 关联笔记。

`apps/server/src/research/fixtures/fastread-bundle.json` 是 Go FastRead `BuildFastWriteBundle` 导出的测试资料，覆盖无作者、无 DOI 的论文交接。运行 `bun test apps/server/src/research/fastread-integration.test.ts` 可验证配对、权限、幂等上传和双向反馈。

## CAS 一键连接与阅读跳转

两端认证同一 CAS 身份后，在 FastRead 设置页点击「通过 CAS 连接 FastWrite」。文献与证据面板提供连接入口，也可从已关联论文直接打开 Read 原文。设置 `FASTWRITE_FASTREAD_PUBLIC_URL` 指定公开 Read 地址，默认 `https://read.fastrd.io`，支持部署路径前缀。

中心需登记独立服务身份 `fastread-sync`，仅允许 `client_credentials`，scope 为 `fastread:connect`，resources 包含本实例实际 CAS client ID。服务密钥只配置在 Read 后端 `FASTREAD_SYNC_CLIENT_SECRET`；Write 使用自己的现有 CAS 配置验签、introspection 和绑定核对。

新增 `POST /api/integrations/fastread/cas-connect` 接收已授权服务令牌与 `{subject}`，按同一 CAS 身份建立连接；不按邮箱合并账号。凭证仅返回 Read 服务端，持久化只存摘要与 CAS 绑定信息。每次请求检查绑定 ID、版本、中心状态及账号状态，解绑后不能使用旧凭证；重绑也需重新连接。CAS 同步不能使用平台管理员的全局权限，仍受项目成员和路径 ACL 限制。

运行 `bun test apps/server/src/auth/fastread-cas.test.ts apps/server/src/research/fastread-integration.test.ts` 验证应用侧协议；中心服务身份与生产回调地址需要部署环境配置和联调。
