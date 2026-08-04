/**
 * Removes text that is already immediately before the cursor. Some providers
 * echo the beginning of a completion even though the editor supplied context.
 */
export function completionSuffix(suggestion: string, textBeforeCursor: string): string {
  const maximum = Math.min(suggestion.length, textBeforeCursor.length);
  for (let size = maximum; size > 0; size -= 1) {
    if (textBeforeCursor.endsWith(suggestion.slice(0, size))) return suggestion.slice(size);
  }
  return separateEnglishWords(suggestion, textBeforeCursor);
}

function separateEnglishWords(suffix: string, textBeforeCursor: string): string {
  if (/[A-Za-z0-9]$/.test(textBeforeCursor) && /^[A-Za-z0-9]/.test(suffix)) return ` ${suffix}`;
  return suffix;
}
