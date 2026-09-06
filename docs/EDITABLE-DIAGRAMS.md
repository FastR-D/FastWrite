# 独立可编辑绘图模块

入口 `/diagrams`。输入需求与可选 SVG，生成受校验的 scene JSON，再渲染原生 draw.io 节点/连接线、PPTX 文本形状/连接线，以及 SVG 预览。可修改文字和位置、编辑完整 JSON、保存新版本、刷新后重新打开和下载。

模型固定 `gpt-6-astra`，不静默换模型。优先使用 `FASTWRITE_DIAGRAM_API_KEY` 和可选 `FASTWRITE_DIAGRAM_BASE_URL` 调用 OpenAI Responses structured output。未设置专用 key 时使用已登录的 Codex CLI，可用 `FASTWRITE_CODEX_COMMAND` 指定程序。服务器 CLI 必须支持当前模型及参数；本次真实接入使用 Codex 0.153.4，旧 0.150.1 被服务端拒绝。没有改全局 CLI 或用户配置。

Codex 仅返回符合 schema 的图结构，不执行模型生成的脚本；CLI 使用 ephemeral、ignore-user-config、read-only，并禁用 shell/apply_patch 工具。SVG 上限 250 KB，拒绝 script、事件、外链、DOCTYPE 和 foreignObject。结构还检查 ID、引用、颜色和边界。

图版本位于 `FASTWRITE_DATA_DIR/diagrams`。生成请求返回 202，服务端依次执行任务；服务重启时中断任务明确失败，须检查后重新提交，避免未知计费结果被自动重放。模型临时输入输出位于 data 下的 diagram-model；需要像研究资料一样保护，不能打包到发布制品。

构建和测试沿用仓库 Bun workspace。新增依赖 pptxgenjs 4.0.1，lock 已更新。上线前设置独立 data 路径、验证已有 FastWrite 访问边界并使用 HTTPS；本次仅本地候选，未改变公开服务。

可编辑导出不依赖嵌入图片：PPTX 包中节点为 native text shapes，连接线为 p:cxnSp，并通过 stCxn/endCxn 引用节点。支持 rect、roundRect、ellipse、diamond；复杂 SVG 经模型转换可能简化，不能保证任意 SVG 逐像素复刻。

验收分别记录模型生成、结构测试、实际浏览器编辑和文件重读。python-pptx 成功打开不等于 PowerPoint GUI 已验收；本机没有 PowerPoint/LibreOffice GUI，本项保留 NOT_TESTED。专用 OpenAI API key 路径已实现，当前真实模型请求使用 Codex 路径。
