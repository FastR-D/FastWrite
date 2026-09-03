#!/usr/bin/env bash
set -euo pipefail

MODE="check"
INSTALL_CURRENT_TEXLIVE=0
INSTALL_FULL=0
for argument in "$@"; do
  case "$argument" in
    --install) MODE="install" ;;
    --texlive-current) INSTALL_CURRENT_TEXLIVE=1 ;;
    --full) INSTALL_FULL=1 ;;
    --check) MODE="check" ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done

if [[ ! -r /etc/os-release ]]; then echo "Unsupported Linux: /etc/os-release is missing" >&2; exit 1; fi
. /etc/os-release
PACKAGE_FAMILY="${ID_LIKE:-$ID}"

required_commands=(latexmk pdflatex xelatex lualatex biber bibtex makeindex pandoc Rscript fc-cache)
missing=()
for command_name in "${required_commands[@]}"; do command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name"); done
missing_assets=()
kpsewhich fontawesome6.sty >/dev/null 2>&1 || missing_assets+=("fontawesome6.sty")
[[ "$(fc-match -f '%{family}\n' JuliaMono 2>/dev/null | head -1)" == *JuliaMono* ]] || missing_assets+=("JuliaMono")
if ! command -v Rscript >/dev/null 2>&1 || ! Rscript -e 'quit(status=ifelse(requireNamespace("rmarkdown", quietly=TRUE),0,1))' >/dev/null 2>&1; then
  missing_assets+=("R package rmarkdown")
fi

echo "Distribution: ${PRETTY_NAME:-$ID}"
echo "Missing commands: ${missing[*]:-none}"
echo "Missing assets: ${missing_assets[*]:-none}"
if [[ "$MODE" == "check" ]]; then
  ((${#missing[@]} == 0 && ${#missing_assets[@]} == 0)) && exit 0
  echo "Run: sudo-independent user assets plus system packages require: $0 --install" >&2
  exit 1
fi

available_kib=$(df -Pk / | awk 'NR==2 {print $4}')
if ((available_kib < 8 * 1024 * 1024)); then echo "Refusing installation: less than 8 GiB is available on /. Free disk space first." >&2; exit 1; fi

if [[ "$PACKAGE_FAMILY" == *debian* || "$PACKAGE_FAMILY" == *ubuntu* ]]; then
  sudo apt-get update
  tex_packages=(texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra texlive-pictures texlive-science texlive-publishers texlive-luatex texlive-xetex)
  ((INSTALL_FULL)) && tex_packages=(texlive-full)
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    "${tex_packages[@]}" latexmk biber pandoc r-base r-cran-rmarkdown \
    fonts-font-awesome fontconfig curl unzip ca-certificates perl make
elif [[ "$PACKAGE_FAMILY" == *fedora* || "$ID" == "fedora" ]]; then
  sudo dnf install -y \
    texlive-scheme-full latexmk biber pandoc R-core R-rmarkdown \
    fontawesome-fonts fontconfig curl unzip perl make
else
  echo "Unsupported package family: $PACKAGE_FAMILY" >&2
  echo "Install TeX Live full, latexmk, biber, pandoc, R+rmarkdown, fontconfig, curl and unzip manually." >&2
  exit 1
fi

cache_directory="${XDG_CACHE_HOME:-$HOME/.cache}/fastwrite-toolchain"
font_directory="${XDG_DATA_HOME:-$HOME/.local/share}/fonts/fastwrite"
mkdir -p "$cache_directory" "$font_directory"

if [[ "$(fc-match -f '%{family}\n' JuliaMono 2>/dev/null | head -1)" != *JuliaMono* ]]; then
  curl --fail --location --retry 3 -o "$cache_directory/JuliaMono.zip" https://github.com/cormullion/juliamono/releases/latest/download/JuliaMono-ttf.zip
  unzip -oq "$cache_directory/JuliaMono.zip" -d "$font_directory/JuliaMono"
  fc-cache -f "$font_directory"
fi

if ! kpsewhich fontawesome6.sty >/dev/null 2>&1; then
  texmf_directory="${TEXMFHOME:-$HOME/texmf}"
  archive="$cache_directory/fontawesome6.zip"
  source_directory="$cache_directory/fontawesome6/fontawesome6"
  curl --fail --location --retry 3 -o "$archive" https://mirrors.ctan.org/fonts/fontawesome6.zip
  unzip -oq "$archive" -d "$cache_directory/fontawesome6"
  mkdir -p "$texmf_directory/tex/latex/fontawesome6"
  cp -a "$source_directory/tex/." "$texmf_directory/tex/latex/fontawesome6/"
  for font_kind in type1 tfm opentype; do
    mkdir -p "$texmf_directory/fonts/$font_kind/fontawesome6"
    cp -a "$source_directory/$font_kind/." "$texmf_directory/fonts/$font_kind/fontawesome6/"
  done
  mkdir -p "$texmf_directory/fonts/enc/dvips/fontawesome6" "$texmf_directory/fonts/map/dvips/fontawesome6"
  cp -a "$source_directory/enc/." "$texmf_directory/fonts/enc/dvips/fontawesome6/"
  cp -a "$source_directory/map/." "$texmf_directory/fonts/map/dvips/fontawesome6/"
  command -v mktexlsr >/dev/null 2>&1 && mktexlsr "$texmf_directory" >/dev/null
  command -v updmap-user >/dev/null 2>&1 && updmap-user --enable Map=fontawesome6.map >/dev/null
fi

if ((INSTALL_CURRENT_TEXLIVE)); then
  echo "--texlive-current requested. Distribution TeX Live replacement is intentionally not automated." >&2
  echo "Use the official installer in an isolated prefix, then place its bin directory before /usr/bin." >&2
  echo "See https://tug.org/texlive/quickinstall.html" >&2
fi

exec "$(dirname "$0")/check-latex-linux.sh"
