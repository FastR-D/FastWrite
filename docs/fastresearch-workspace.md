# Read / News / Write 个人动态

工作台按当前已认证账号读取 `GET /api/workspace/apps/{fast-read|fast-news|fast-write}/activity`，前端不能指定收件人。CAS 登录使用会话 subject；Key 登录仅使用已存在且经中心确认的 Research 绑定，没有绑定时提示使用关联 CAS 账号。不会按邮箱、姓名匹配账号。

| 应用 | 指标 | 动态 |
| --- | --- | --- |
| Read | 所属工作区未归档论文、报告版本、笔记、本人待处理任务 | 最近入库论文、生成报告、笔记更新、失败或待处理任务 |
| News | 本人未读订阅、已收录论文、研究简报 | 本人未读订阅、按日期排序的新收录论文、最新简报 |
| Write | 本人未读评论、未读提及、实际参与项目 | 当前仍有文件读取权限的评论/提及、最近项目更新 |

News 的语料收录数不是个人未读论文数；Read 的入库时间不是阅读记录。Write 不因平台管理员身份枚举其他人的项目。每次读取最多八个指标、八条动态，不返回正文、笔记内容、评论内容、邮箱、凭证；不改变已读状态、不创建账号。

## 子应用接口

三个正式后端均提供 `POST /api/integrations/fastresearch/workspace`，请求 JSON 仅接受 `{"subject":"CAS subject"}`。仅供服务端调用。需要 FastCAS 签名服务 access token，`sub=client_id=fastresearch`、`service=true`、scope `workspace:read`、aud 包含接收应用配置的 CAS client ID。还会进行中心 introspection、校验 issuer/client/subject 的本地绑定和中心绑定 ID、状态、版本；停用账号、撤销绑定不会返回个人动态。

成功响应示例：

```json
{"schemaVersion":"fastresearch.workspace.v1","appId":"fast-write","accountState":"active","updatedAt":"2026-11-12T00:00:00Z","metrics":[{"id":"comments","label":"未读评论","value":2}],"items":[{"id":"notification-id","kind":"comment","title":"论文讨论有更新","description":"项目有新评论","path":"/projects/project-id","occurredAt":"2026-11-12T00:00:00Z"}]}
```

`missing` 表示没有此 issuer/client/subject 绑定，`inactive` 表示账号或绑定已停用，均不含指标和动态。验证失败返回 401/403，中心或数据源不可用返回 503。Research 聚合层将故障显示为 `unavailable`，不显示注册按钮；只有确实 `missing` 才展示注册/开通入口。应用没有配置服务身份时为 `not_configured`，Key 无映射时为 `requires_cas`。

子应用只返回以 `/` 开头的相对链接；Research 校验协议和大小后转为配置的应用公开地址，浏览器不会收到服务令牌。聚合及子应用响应均禁止缓存。工作台仅拉取当前选中应用，页面可见时每分钟刷新，切换账号或应用会取消旧请求。

## 部署配置

Research 使用 `FASTNEWS_URL`、`FASTREAD_URL`、`FASTWRITE_URL` 访问后端；`FASTNEWS_PUBLIC_URL`、`FASTREAD_PUBLIC_URL`、`FASTWRITE_PUBLIC_URL` 配置浏览器入口，内外地址可不同。可选 `FASTNEWS_REGISTER_URL`、`FASTREAD_REGISTER_URL`、`FASTWRITE_REGISTER_URL` 覆盖开通入口。Read 默认 `/?auth=register`、News 默认 `/login?mode=register`，保留邀请码要求；Write 默认通过 FastCAS 登录开通，遵守 Write 自身策略。Research 不提供自行注册。

独立配置服务凭证（需三项同时填写）：

```dotenv
FASTRESEARCH_WORKSPACE_SERVICE_ISSUER=https://cas.fastrd.io
FASTRESEARCH_WORKSPACE_SERVICE_CLIENT_ID=fastresearch
FASTRESEARCH_WORKSPACE_SERVICE_CLIENT_SECRET=<通过部署 secret 注入>
FASTRESEARCH_WORKSPACE_SERVICE_ALLOW_LOOPBACK_HTTP=false
```

未配置时复用已配置的 Write、其次 Task 的 OAuth 服务身份；请求失败不回退个人 Key 或共享 API Key。专用凭证仍须属于 `fastresearch`。

## FastCAS 权限

由中心管理员在“应用权限”中修改服务身份 `fastresearch` 的 capabilities，保留已有 scope 和 resources，新增 scope `workspace:read`，新增资源受众 **子应用实际配置的 CAS client ID**（当前示例 `fastread`、`news`、`fastwrite`）。不要写成 `*-api`：接收应用的 introspection 要求自身 client ID 在令牌 aud 中。服务身份仍只允许 `client_credentials`，不可增加交互登录权限。

对应 API 为 `POST /api/v1/admin/applications/fastresearch/capabilities`，要求近期 MFA、同源与 CSRF。请求字段是 `grant_types`、`scopes`、`resources`，应提交原值与新增值的并集。不要重新登记或轮换现有客户端来覆盖权限。部署代码不会自动扩大中心授权，也不含中心数据库或管理员凭证。

完成授权后，以服务身份请求 `/oauth/token` 的 `workspace:read` scope，逐个调用三个摘要端点：已有绑定返回 active，未绑定返回 missing，撤销服务令牌返回 401/403。再在实际工作台检查三张个人动态面板。缺少中心权限时，工作台会明确显示不可用，不伪造动态。
