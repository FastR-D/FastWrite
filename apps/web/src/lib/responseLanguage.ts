export type ResponseLanguage = "auto" | "zh-CN" | "en-US";
const KEY = "fastwrite.response-language";
export function responseLanguage(): ResponseLanguage {
  const value = localStorage.getItem(KEY);
  return value === "zh-CN" || value === "en-US" ? value : "auto";
}
export function setResponseLanguage(value: ResponseLanguage): void { localStorage.setItem(KEY, value); }
