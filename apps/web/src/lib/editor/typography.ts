/** Read the same fonts as the workbench; Monaco does not resolve CSS variables. */
export function editorTypography() {
  const style = getComputedStyle(document.documentElement);
  return {
    fontFamily: style.getPropertyValue("--fw-font-mono").trim(),
    fontWeight: style.getPropertyValue("--fw-font-weight-code").trim(),
    fontSize: 14,
    lineHeight: 24,
    fontLigatures: false
  };
}
