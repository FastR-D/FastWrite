# Standalone TeX environment image. Mount into the server only as an operator-managed
# environment, or use this package set in your FastWrite Linux deployment image.
FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    latexmk texlive-latex-base texlive-latex-recommended texlive-latex-extra \
    texlive-science texlive-pictures texlive-publishers texlive-fonts-recommended \
    texlive-xetex texlive-luatex texlive-lang-chinese biber \
    fonts-noto-cjk fonts-dejavu-core fontconfig ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
ENTRYPOINT ["latexmk", "-norc", "-no-shell-escape", "-file-line-error", "-interaction=nonstopmode", "-halt-on-error", "-synctex=1"]
CMD ["-pdf", "main.tex"]
