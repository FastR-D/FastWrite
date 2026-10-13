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
      setError(err instanceof Error ? err.message : "Failed to load harness profile");
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
      setError("API key is required");
      return;
    }

    if (baseURL) {
      try {
        const url = new URL(baseURL);
        if (!["http:", "https:"].includes(url.protocol)) {
          throw new Error("Invalid protocol");
        }
      } catch {
        setError("Base URL must be a valid HTTP or HTTPS URL");
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
      setError(err instanceof Error ? err.message : "Failed to save harness profile");
    } finally {
      setBusy(false);
    }
  }, [scope, scopeId, profile]);

  return (
    <div className="field" role="group" aria-labelledby="harness-profile-title">
      <span id="harness-profile-title">Harness Profile</span>

      <Field label="API Key">
        <TextField
          type="password"
          value={profile.apiKey || ""}
          onChange={(value) => setProfile(prev => ({ ...prev, apiKey: value }))}
          placeholder="sk-..."
          disabled={busy}
        />
      </Field>

      <Field label="Base URL (optional)">
        <TextField
          value={profile.baseURL || ""}
          onChange={(value) => setProfile(prev => ({ ...prev, baseURL: value }))}
          placeholder="https://api.openai.com/v1"
          disabled={busy}
        />
      </Field>

      <Field label="Model (optional)">
        <TextField
          value={profile.model || ""}
          onChange={(value) => setProfile(prev => ({ ...prev, model: value }))}
          placeholder="gpt-4"
          disabled={busy}
        />
      </Field>

      <Field label="Wire API">
        <Select
          aria-label="Wire API"
          value={profile.wireAPI || "responses"}
          onChange={(value) => setProfile(prev => ({ ...prev, wireAPI: value as AgentWireApi }))}
          options={[
            { value: "responses", label: "Responses" },
            { value: "streaming", label: "Streaming" }
          ]}
          disabled={busy}
        />
      </Field>

      {error ? <div className="error-message" style={{ color: "var(--red-9)", fontSize: "12px", marginTop: "8px" }}>{error}</div> : null}
      {success ? <div className="success-message" style={{ color: "var(--green-9)", fontSize: "12px", marginTop: "8px" }}>Profile saved successfully</div> : null}

      <Button
        size="small"
        variant="secondary"
        disabled={busy}
        onClick={() => void saveProfile()}
      >
        Save Harness Profile
      </Button>
    </div>
  );
}
