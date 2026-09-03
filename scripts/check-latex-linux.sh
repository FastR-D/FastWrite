#!/usr/bin/env bash
set -euo pipefail

failed=0
check_command() { if command -v "$1" >/dev/null 2>&1; then printf 'PASS command %-14s %s\n' "$1" "$(command -v "$1")"; else printf 'FAIL command %s\n' "$1"; failed=1; fi; }
for command_name in latexmk pdflatex xelatex lualatex biber bibtex makeindex pandoc Rscript fc-cache; do check_command "$command_name"; done

if command -v pdflatex >/dev/null 2>&1; then pdflatex --version | head -1; fi
if kpsewhich fontawesome6.sty >/dev/null 2>&1; then echo "PASS TeX package fontawesome6"; else echo "FAIL TeX package fontawesome6"; failed=1; fi
if [[ "$(fc-match -f '%{family}\n' JuliaMono 2>/dev/null | head -1)" == *JuliaMono* ]]; then echo "PASS font JuliaMono"; else echo "FAIL font JuliaMono"; failed=1; fi
if command -v Rscript >/dev/null 2>&1 && Rscript -e 'quit(status=ifelse(requireNamespace("rmarkdown", quietly=TRUE),0,1))' >/dev/null 2>&1; then echo "PASS R package rmarkdown"; else echo "FAIL R package rmarkdown"; failed=1; fi

available_kib=$(df -Pk / | awk 'NR==2 {print $4}')
if ((available_kib >= 8 * 1024 * 1024)); then echo "PASS disk space $((available_kib / 1024 / 1024)) GiB available"; else echo "FAIL disk space: less than 8 GiB available"; failed=1; fi
swap_total=$(awk '/SwapTotal/ {print $2}' /proc/meminfo); swap_free=$(awk '/SwapFree/ {print $2}' /proc/meminfo)
if ((swap_total == 0 || swap_free * 100 / swap_total >= 5)); then echo "PASS swap availability"; else echo "WARN swap is over 95% used"; fi
latex_year=$(pdflatex --version 2>/dev/null | sed -n 's/.*TeX Live \([0-9][0-9][0-9][0-9]\).*/\1/p' | head -1)
if [[ -n "$latex_year" && "$latex_year" -ge 2023 ]]; then echo "PASS LaTeX year $latex_year"; else echo "WARN LaTeX year ${latex_year:-unknown}; some current projects will be unavailable"; fi

exit "$failed"
