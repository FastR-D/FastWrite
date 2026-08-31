# Linux LaTeX toolchain

FastWrite 的真实项目评测需要 `pdfLaTeX`、`XeLaTeX`、`LuaLaTeX`、`latexmk`、`biber`、Pandoc，以及 R Markdown 项目所需的 `Rscript`/`rmarkdown`。部分基线还使用 Font Awesome 6 和 JuliaMono。

先运行只读诊断：

```bash
bun run latex:check
```

在 Debian、Ubuntu、Zorin 或 Fedora 上安装完整环境：

```bash
bun run latex:setup
```

脚本默认安装覆盖 FastWrite 所需的精简 TeX Live collection、Biber、Pandoc、R Markdown 和基础构建工具；JuliaMono 与缺失的 Font Awesome TeX 文件安装在用户目录。仅在确实需要所有语言和文档包时使用 `bash scripts/setup-latex-linux.sh --install --full`。安装前脚本要求根分区至少有 8 GiB 可用空间。

安装后重新运行 `bun run latex:check`，再执行：

```bash
bun run papers:compile -- --root /path/to/checkouts
bun run papers:eval -- --root /path/to/checkouts
```

编译运行器会按项目使用显式引擎和构建命令。缺少命令、TeX package、字体或最低 LaTeX 版本会记录为 `unavailable`，不会计为 FastWrite 编译失败。
