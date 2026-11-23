# 正在处理的Bug与进行的开发任务

已完成并验证的条目会移至 `BUG-done.md`。

`BUG-new.md` 保留为持续录入的新问题文件，不会被删除或覆盖。

## 功能 Bug

- **线上默认论文无法编译为 PDF。** 2026-11-23 在 `write.fastrd.io` 使用 FastCAS 登录后新建个人论文，默认 `article` 模板自动编译失败，手动重试仍失败。PDF 预览显示退出码 `1`，编译输出为 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`。输出页同时显示「尚未编译」。检查线上编译进程的 Bubblewrap 沙箱运行条件，并让输出页正确显示失败状态。

  本地已通过 Bubblewrap 的 PDF 和 SyncTeX 验证，失败时界面会显示编译失败和日志。生产主机的 Bubblewrap 探针仍报错，且缺少 `texlive-xetex` 和 `texlive-lang-chinese`。需要管理员加载 Bubblewrap 专用 AppArmor 配置并安装 TeX 依赖，再用中英文默认论文分别验证 PDF。当前 SSH 账号缺少所需的免交互 sudo 权限。 [部署说明](fastdeploy.md#生产编译与实时协作)

- **线上实时协作反复断开。** 同日进入新建个人论文，工具栏从「协作已开启」变为「协作离线」，刷新协作后仍显示离线，讨论面板同时显示「1 人在线」。浏览器观察到 `/api/collaboration/socket` 反复建立连接、报错并关闭，未捕获到成功的 WebSocket 握手。项目级评论仍可通过普通请求提交。检查线上 WebSocket 握手和代理日志，并核对界面连接状态与在线人数的含义。

  本地握手返回 `101`，以 `4008` 模拟空闲断线后两页可重新握手并同步修改。界面分别显示实时连接和正在浏览项目的人数，「刷新协作」可重连未同步的连接。生产 Edge 扩展观察到令牌接口返回 `200`，握手发出后未收到 `101`。线上代理修改和复测见 [部署说明](fastdeploy.md#生产编译与实时协作)。

## 需要 Justify 的设计

## 优化点

- **线上首屏长时间空白，FastCAS 回跳也受影响。** 2026-11-23 使用 Edge 浏览器扩展访问并刷新 `https://write.fastrd.io/`。刷新时 HTML 返回 `200`，约 354 ms 收到响应头。首屏请求的 `monaco-B96agFfT.js` 传输约 4.49 MB，耗时约 25.8 秒。页面在此期间没有内容或加载提示，脚本下载后才开始加载项目页模块。FastCAS 回跳 `/panel?fastcas=complete` 时也观察到空白。优先检查线上静态资源压缩、缓存和传输，并将 Monaco 延后到进入编辑工作区时加载。

  本地生产构建中，首页、项目列表和模拟 FastCAS 回跳均未请求 Monaco。进入工作区时，Monaco JS 通过 gzip 从约 4.49 MB 降至 1.15 MB。等待发布后复测公网首屏请求，并确认代理透传压缩和缓存头。
