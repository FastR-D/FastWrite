# FastWrite 服务器部署

`.github/workflows/tag-ci.yml` 在 main、PR 和版本标签上验证并构建；只有推送 `v*` 标签会通过 FastDeploy 部署到 `fastrd`。普通提交的 commit message 包含 `v` 不会触发部署。手动运行验证 workflow 也不会直接部署。

普通运行参数直接写在该 workflow 的 `runtime-env`，使用字面 `KEY=value`，不要加 shell 引号。敏感值用该文件 `runtime-secrets` 中的同名仓库 Secrets，使用 `toJSON` 保留特殊字符。SSH 五项来自 FastR-D 组织的 `FASTRD_SSH_*` Secrets；请勿把凭证写入 YAML 或构建产物。

构建 job 上传同一次运行的 `release.tar.gz` 和 `manifest.json`。FastDeploy 和打包器均固定到完整提交 `9a2c51dcd63f47a0e6c8f6bb07bd22ea589abbd2`，服务器不拉源码或重新安装依赖。代码相对路径由 [FastDeploy 应用配置](https://github.com/FastR-D/FastDeploy/blob/9a2c51dcd63f47a0e6c8f6bb07bd22ea589abbd2/config/apps.json) 注入，业务数据使用其中记录的原持久化路径。

发布示例（版本号每次必须唯一）：

```bash
git tag v2026.11.11.1
git push origin v2026.11.11.1
```

生产 Environment 仅允许 `v*` 标签和 main 上的手动回滚。切换后自动检查就绪，失败恢复旧代码和运行配置；数据库不会随代码回滚。需要回滚时，在 main 手动执行 `.github/workflows/rollback.yml`，输入部署日志中的准确当前 release ID；若当前版本已变化则拒绝执行。

适配 main 提交不会重启当前业务。首个生产标签仍需验证登录、集成功能及数据兼容性。完整运行时、共享目录、旧服务接管和检查限制见 [FastDeploy README](https://github.com/FastR-D/FastDeploy#readme)。

## 生产编译与实时协作

Ubuntu 24.04 主机上，如果 `bwrap` 报 `loopback: Failed RTM_NEWADDR: Operation not permitted`，先用 FastWrite 服务账号运行下面的探针。管理员可以从 `apparmor-profiles` 的 `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` 安装并加载 Ubuntu 提供的 `/usr/bin/bwrap` 专用配置，再重复探针。它允许 Bubblewrap 建立沙箱，并限制沙箱内进程的能力。 [Ubuntu 软件包文件列表](https://packages.ubuntu.com/noble-updates/all/apparmor-profiles/filelist) · [Ubuntu Bubblewrap 配置说明](https://documentation.ubuntu.com/release-notes/25.04/)

```bash
setpriv --no-new-privs -- /usr/bin/bwrap --unshare-all --die-with-parent \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \
  -- /usr/bin/true
```

生产主机尚未安装该配置时，由管理员运行以下命令。加载后以服务账号重新运行探针，确认成功后再发布。

```bash
sudo apt-get install apparmor-profiles
sudo apparmor_parser -Q -T /usr/share/apparmor/extra-profiles/bwrap-userns-restrict
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

在 `write.fastrd.io` 生效的 TLS 站点配置中，给协作握手配置精确路由，直接转发到 FastWrite 的本机监听端口。将第一行的日志格式定义放在 `http` 块中，`location` 放在该站点的 `server` 块内。验证 `nginx -t` 后重载，再使用已登录账号打开同一篇测试论文的两个页面，确认握手返回 `101` 且两页能收到彼此的修改。 [Nginx WebSocket 代理文档](https://nginx.org/en/docs/http/websocket.html)

```nginx
log_format fastwrite_ws '$time_iso8601 $host $uri $status $upstream_status';

location = /api/collaboration/socket {
    proxy_pass http://127.0.0.1:3003;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 75s;
    access_log /var/log/nginx/fastwrite-ws.log fastwrite_ws;
}
```

中文项目名的默认论文使用 XeLaTeX、CTeX 和 Fandol 字体。Ubuntu 生产主机需安装 `texlive-xetex` 和 `texlive-lang-chinese`。以服务账号确认 `xelatex`、`kpsewhich ctex.sty` 和 `kpsewhich FandolSong-Regular.otf` 可运行或找到相应文件。首次发布时，分别新建中文和英文标题的默认 `article` 论文并验证 PDF。

访问带哈希的新版 Monaco JS 时，支持 gzip 的客户端应收到 `Content-Encoding: gzip`、`Vary: Accept-Encoding` 和 `Cache-Control: public, max-age=31536000, immutable`。首页、登录回跳和项目列表应保持零 Monaco 请求。
