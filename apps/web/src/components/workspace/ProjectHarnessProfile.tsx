import { useCallback, useEffect, useState } from "react";
import { Button, Field, Select, TextField } from "../ui";
import type { AgentWireApi } from "@fastwrite/shared";
import { api } from "../../api/client";

interface HarnessProfileEditorProps {
  scope: "team" | "project" | "system";
  teamId?: string;
  projectId?: string;
}

interface HarnessProfile {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  wireAPI?: AgentWireApi;
}

export function HarnessProfileEditor({ scope, teamId, projectId }: HarnessProfileEditorProps) {
  const [profile, setProfile] = useState<HarnessProfile>({
    apiKey: "",
    baseURL: "",
    model: "",
    wireAPI: "responses"
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const scopeId = teamId || projectId;

  const loadProfile = useCallback(async () => {
    if (!scopeId) return;
    try {
      // TODO: 实际的 API 调用根据后端实现调整
      // const data = scope === "team"
      //   ? await api.teams.harnessProfile(scopeId)
      //   : await api.projects.harnessProfile(scopeId);
      // setProfile(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法加载模型配置");
    }
  }, [scope, scopeId]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const saveProfile = useCallback(async () => {
    if (!scopeId) return;

    const apiKey = profile.apiKey?.trim();
    const baseURL = profile.baseURL?.trim();
    const model = profile.model?.trim();

    if (!apiKey) {
      setError("请填写 API 密钥");
      return;
    }

    if (baseURL) {
      try {
        const url = new URL(baseURL);
        if (!["http:", "https:"].includes(url.protocol)) {
          throw new Error("协议无效");
        }
      } catch {
        setError("服务地址必须为有效的 HTTP 或 HTTPS 地址");
        return;
      }
    }

    setBusy(true);
    setError("");
    setSuccess(false);

    try {
      // TODO: 实际的 API 调用根据后端实现调整
      // if (scope === "team") {
      //   await api.teams.updateHarnessProfile(scopeId, {
      //     apiKey,
      //     baseURL: baseURL || undefined,
      //     model: model || undefined,
      //     wireAPI: profile.wireAPI || "responses"
      //   });
      // } else {
      //   await api.projects.updateHarnessProfile(scopeId, {
      //     apiKey,
      //     baseURL: baseURL || undefined,
      //     model: model || undefined,
      //     wireAPI: profile.wireAPI || "responses"
      //   });
      // }
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法保存模型配置");
    } finally {
      setBusy(false);
    }
  }, [scope, scopeId, profile]);

  return (
    <div className="field" role="group" aria-labelledby="harness-profile-title">
      <span id="harness-profile-title">模型配置</span>

      <Field label="API 密钥">
        <TextField
          type="password"
          value={profile.apiKey || ""}
          onChange={(value) => setProfile(prev => ({ ...prev, apiKey: value }))}
          placeholder="sk-..."
          disabled={busy}
        />
      </Field>

      <Field label="服务地址（可选）">
        <TextField
          value={profile.baseURL || ""}
          onChange={(value) => setProfile(prev => ({ ...prev, baseURL: value }))}
          placeholder="https://api.openai.com/v1"
          disabled={busy}
        />
      </Field>

      <Field label="模型（可选）">
        <TextField
          value={profile.model || ""}
          onChange={(value) => setProfile(prev => ({ ...prev, model: value }))}
          placeholder="gpt-4"
          disabled={busy}
        />
      </Field>

      <Field label="接口协议">
        <Select
          aria-label="接口协议"
          value={profile.wireAPI || "responses"}
          onChange={(value) => setProfile(prev => ({ ...prev, wireAPI: value as AgentWireApi }))}
          options={[
            { value: "responses", label: "Responses 接口" },
            { value: "streaming", label: "流式传输" }
          ]}
          disabled={busy}
        />
      </Field>

      {error ? <div className="error-message" style={{ color: "var(--red-9)", fontSize: "12px", marginTop: "8px" }}>{error}</div> : null}
      {success ? <div className="success-message" style={{ color: "var(--green-9)", fontSize: "12px", marginTop: "8px" }}>配置已保存</div> : null}

      <Button
        size="small"
        variant="secondary"
        disabled={busy}
        onClick={() => void saveProfile()}
      >
        保存模型配置
      </Button>
    </div>
  );
}
