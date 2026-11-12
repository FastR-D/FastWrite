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
