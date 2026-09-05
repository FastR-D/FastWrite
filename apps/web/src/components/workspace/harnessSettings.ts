import type { AgentWireApi } from "@fastwrite/shared";

export interface HarnessSettingsDraft { apiKey: string; baseURL: string; model: string; wireAPI: AgentWireApi }
export interface HarnessSettingsBaseline { configured: boolean | null; baseURL: string; model: string; wireAPI: AgentWireApi }
export type HarnessSettingsSaveDecision = { kind: "unchanged" } | { kind: "invalid"; message: string } | { kind: "save"; body: { apiKey: string; baseURL?: string; model?: string; wireAPI: AgentWireApi } };
export function harnessSettingsSaveDecision(draft: HarnessSettingsDraft, baseline: HarnessSettingsBaseline): HarnessSettingsSaveDecision {
  const apiKey = draft.apiKey.trim(); const baseURL = draft.baseURL.trim(); const model = draft.model.trim();
  const changed = baseURL !== baseline.baseURL.trim() || model !== baseline.model.trim() || draft.wireAPI !== baseline.wireAPI;
  if (!apiKey && !changed) return { kind: "unchanged" };
  if (!apiKey) return { kind: "invalid", message: "Enter an API key to save the Harness settings." };
  if (baseURL) { try { const url = new URL(baseURL); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); } catch { return { kind: "invalid", message: "Base URL must be a valid HTTP or HTTPS URL." }; } }
  return { kind: "save", body: { apiKey, ...(baseURL ? { baseURL } : {}), ...(model ? { model } : {}), wireAPI: draft.wireAPI } };
}
