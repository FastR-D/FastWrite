# 可选 FastCAS 认证与登录

FastWrite 保留本地账号、密码、项目权限和用户 ID。部署方未配置 FastCAS 时不会发起 discovery 请求；本地登录和项目编辑仍走原路径。部署模式关闭普通自助注册，管理员可在 `/panel` 的“用户管理”中创建账号。

## 本地开发配置

SDK 使用 npm 发布的 [`@fastrd/fastcas`](https://www.npmjs.com/package/@fastrd/fastcas)，在 FastWrite 根目录运行 `bun install` 即可安装。版本由 `apps/server/package.json` 声明、`bun.lock` 锁定，无需克隆或构建相邻的 FastCAS 仓库。服务端通过 `@fastrd/fastcas/server` 导入；浏览器代码不会导入服务端 SDK 或客户端密钥。

同时设置以下四项（缺任一项会拒绝启动，避免误以为已启用）：

```dotenv
FASTWRITE_FASTCAS_ISSUER=https://cas.example.org
FASTWRITE_FASTCAS_CLIENT_ID=fastwrite
FASTWRITE_FASTCAS_CLIENT_SECRET=<应用独立随机密钥>
FASTWRITE_FASTCAS_REDIRECT_URI=https://write.example.org/api/auth/fastcas/callback
```

在 FastCAS 登记相同 client ID、密钥、精确 callback，scope 使用 `openid profile email`，事件接收地址设为 `https://write.example.org/api/auth/fastcas/events`。本机开发可以显式设置 `FASTWRITE_FASTCAS_LOOPBACK_HTTP=true`，两端都必须使用 loopback 地址。传统校园 CAS 和通用 OIDC 的原配置不变，FastCAS 使用独立命名。

配置 FastCAS 后默认允许已验证 FastCAS 身份注册并绑定 FastWrite。可设置 `FASTWRITE_FASTCAS_ALLOW_SIGNUP=false` 关闭此流程；它独立于部署模式关闭的普通注册。关闭 FastCAS 登录或新绑定也会关闭注册绑定。

## 当前已接通的用户流程

登录原项目账号后，在项目列表点击 Account authentication；有 FastWrite 密码的账号确认该密码，无密码的旧 OIDC/CAS 账号使用下述近期原提供方证明，再前往 FastCAS 登录并确认认证。回调同时验证浏览器绑定和原本地 refresh 会话；本地 ID、项目及权限不变。不按邮箱合并账号，不将 FastCAS groups 赋予团队权限。

认证成功后可通过 Continue with FastCAS 登录该原账号。FastCAS 签发的令牌仅在服务端处理，浏览器获得的是原 FastWrite 本地会话。解绑需要确认本地密码；只撤销该绑定对应的 FastCAS 来源会话和协作房间令牌，保留本地登录。刷新会话保留认证来源和原认证时间。

绑定采用 prepare → 本地 pending 持久化 → activate → 本地 active。中途网络失败时，账号认证弹窗提供 Check pending authentication，按原 link ID 重试。事件 ID 去重、绑定版本判断与会话撤销在同一个本地写事务中完成，已提交的重复事件返回成功。收到解绑后服务通知当前进程协作连接重新校验。

没有本地密码的旧 OIDC/CAS 账号可先通过**原提供方**重新登录，再在五分钟内于账号认证弹窗绑定或解除 FastCAS。服务端要求该账号确有旧提供方身份、会话来源是刚完成的外部登录，并核对原本地用户与会话；刷新只继承最初认证时间，不延长五分钟窗口。已有本地密码的账号仍须输入本地密码，不能以外部会话绕过。只有 FastCAS 一种登录方式的账号不能直接解除最后绑定。弹窗会根据当前账号的可用证明显示密码或重新登录提示。

已有 FastCAS 账号、尚无绑定的用户点击“使用 FastCAS 登录”并验证身份后，会返回 `/panel?fastcas=register`，前端弹窗要求填写名称、FastWrite 登录邮箱、密码和确认密码。短期注册证明绑定 HttpOnly 浏览器 cookie，五分钟过期并持久化保存；不会在 URL 或浏览器中暴露上游令牌。表单提交后启动 SDK 的独立 `register` 事务并再次确认同一 FastCAS 身份，只有成功 prepare 后才原子创建全新普通用户、本地密码凭证和 pending 绑定，再激活并登录。回调也会重新检查登录、绑定和注册开关。已有邮箱会提示先登录 FastWrite 后在“账号认证”中绑定，不会自动合并账号或继承其他账号权限。

FastCAS 未验证的邮箱声明不会预填入注册表单。用户填写的登录邮箱若不等于 FastCAS 已验证邮箱，仅作为本地登录 ID；用于邀请授权的账号邮箱保存为内部占位地址，避免继承未经验证邮箱的邀请。激活响应丢失时，下次 FastCAS 登录会对账并完成已有 pending 绑定，不重复创建用户。旧版仅有 FastCAS 登录方式的账号仍可在近期 FastCAS 会话中添加本地密码。

## 存储与验证

JSON schema 增量升级至 15，新增 FastCAS 事务、绑定、已处理事件，以及可选会话来源字段。原用户、密码和业务表保留。写事务串行，文件权限为 0600。PostgreSQL cutover 模式在每次写操作完成前提交 primary，不能只在整个 HTTP handler 返回后做镜像同步；JSON 仍作为本地缓存。mirror 模式的原语义保留。

从 FastCAS 目录运行：

```sh
FASTCAS_PROJECT_CONTRACT=1 go test ./internal/httpapi -run TestFastWrite -count=1 -v
```

该测试启动真实 FastCAS HTTP 服务并使用隔离 PostgreSQL schema，以 FastWrite HTTP 路由完成本地注册、创建项目、双端认证、FastCAS 登录、刷新、解绑和本地重新登录；验证用户 ID、角色、项目可见性及协作令牌失效。FastWrite 本身的认证和存储测试也覆盖回调跨重启、并发单次消费、primary 写失败及同邮箱不合并。

## 尚未完成的接入项

旧 OIDC/CAS 无密码账号的近期原提供方证明路径已实现，并通过真实 FastCAS → FastWrite 联调：同邮箱本地账号不合并、旧项目归属不变、FastCAS 登录回到原旧账号、原提供方会话可解除绑定。FastCAS 新开户账号添加本地密码也已通过真实提供方联调：未添加前拒绝解除最后登录方式，添加后可解绑、用本地登录 ID 回到同一用户；同邮箱原账号仍能用自己的密码登录，跨站 Origin 被拒绝。联调在模拟 FastCAS 不可用时再次完成本地登录，证明备用入口不发中心请求。真实 Chrome/Bun FastWrite/Go FastCAS/PostgreSQL 浏览器契约覆盖本地登录、绑定、独立浏览器 CAS 登录、原用户/项目保持和解绑来源隔离；故意延迟回调刷新暴露的未登录页面时序已修复。跨进程协作撤销、完整 PostgreSQL 真实接入测试及生产域名视觉验收仍在实施，不将当前试点视为完整规划交付。

FastCAS 应用登记还需设置 `backchannel_logout_uri` 为 `https://write.example.org/api/auth/fastcas/backchannel-logout`。接收端验证标准签名 `logout_token`，按身份及可选 sid 原子去重，只撤销 FastCAS 来源会话；项目本地登录、账号、内容和权限保持独立。

`events_uri` 同时接收签名 `identity.status_changed` 通知。中心停用身份会撤销对应 FastCAS 来源会话，重新启用不会恢复旧会话；本地密码登录及项目 ACL 保持独立。真实提供方到 FastWrite 接收端的状态事件契约已通过。

## 独立启停开关（2026-11-11）

四项连接配置完整时默认启用，未配置时保留原有入口且不访问中心。可显式设置：

| 环境变量 | 默认 | 行为 |
| --- | --- | --- |
| `FASTWRITE_FASTCAS_ENABLED` | `true`（仍需完整连接配置） | `false` 时完全关闭可选 FastCAS provider，允许保留未填完的配置 |
| `FASTWRITE_FASTCAS_LOGIN_ENABLED` | `true` | `false` 时隐藏并拒绝新的 FastCAS 登录，阻断已发起登录的回调签发会话 |
| `FASTWRITE_FASTCAS_LINK_ENABLED` | `true` | `false` 时拒绝新绑定、注册绑定及 pending 激活，仍允许查询和撤销已有关系 |
| `FASTWRITE_FASTCAS_ALLOW_SIGNUP` | `true` | `false` 时关闭已验证 FastCAS 身份注册新 FastWrite 账号的表单及回调 |

使用字面量 `false` 关闭。两个分项开关不会阻断签名事件、来源会话撤销或原本地登录，也不改变账号和业务数据；全局关闭时 CAS 来源会话在项目原有有效性检查边界失效。保留独立的本地恢复方式后再关闭中心登录。

发布依赖基线更新为 FastCAS SDK **0.1.2**：使用正式 npm/PyPI 包或 Go 模块标签，不再依赖同级 FastCAS 源码目录。开发者修改 SDK 时可自行使用本地 override；生产锁文件固定已验收版本。
