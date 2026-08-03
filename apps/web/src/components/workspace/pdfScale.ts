export const MIN_PDF_SCALE = 0.25;
export const MAX_PDF_SCALE = 2.2;

export function fitPdfPageScale(containerWidth: number, containerHeight: number, pageWidth: number, pageHeight: number, padding = 36): number | null {
  const availableWidth = containerWidth - padding;
  const availableHeight = containerHeight - padding;
  if (availableWidth <= 0 || availableHeight <= 0 || pageWidth <= 0 || pageHeight <= 0) return null;
  return Math.max(MIN_PDF_SCALE, Math.min(MAX_PDF_SCALE, availableWidth / pageWidth, availableHeight / pageHeight));
}
