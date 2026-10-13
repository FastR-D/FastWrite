import { useCallback, useEffect, useState } from "react";
import { Button, Field, Select, TextField } from "../ui";
import { api } from "../../api/client";

interface ReferenceStylePanelProps {
  projectId: string;
  path?: string;
  onApplied?: () => void;
}

interface StyleProfile {
  id: string;
  name: string;
  description: string;
  features: string[];
}

interface RewriteConfig {
  targetStyleId: string;
  scope: "document" | "selection";
  preserveCitations: boolean;
  preserveFormatting: boolean;
}

type RewriteStep = "select-style" | "configure" | "preview" | "apply";

export function ReferenceStylePanel({
  projectId,
  path,
  onApplied,
}: ReferenceStylePanelProps) {
  const [step, setStep] = useState<RewriteStep>("select-style");
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [config, setConfig] = useState<RewriteConfig>({
    targetStyleId: "",
    scope: "document",
    preserveCitations: true,
    preserveFormatting: false,
  });
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadProfiles();
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      // TODO: 实际的 API 调用
      // const data = await api.papers.styleProfiles();
      // setProfiles(data);

      // 临时模拟数据
      setProfiles([
        {
          id: "ieee",
          name: "IEEE",
          description: "IEEE conference/journal style",
          features: ["formal", "technical", "concise"],
        },
        {
          id: "acm",
          name: "ACM",
          description: "ACM conference/journal style",
          features: ["formal", "structured", "clear"],
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load style profiles");
    }
  }, []);

  const generatePreview = useCallback(async () => {
    if (!config.targetStyleId || !path) {
      setError("Please select a style and ensure a document is open");
      return;
    }

    setBusy(true);
    setError("");

    try {
      // TODO: 实际的 API 调用
      // const result = await api.papers.previewStyleTransfer(projectId, {
      //   path,
      //   ...config,
      // });
      // setPreview(result.preview);

      setPreview("Preview: This is how your text will look after applying the selected style...");
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate preview");
    } finally {
      setBusy(false);
    }
  }, [projectId, path, config]);

  const applyStyle = useCallback(async () => {
    if (!config.targetStyleId || !path) return;

    setBusy(true);
    setError("");

    try {
      // TODO: 实际的 API 调用
      // await api.papers.applyStyleTransfer(projectId, {
      //   path,
      //   ...config,
      // });

      setStep("apply");
      onApplied?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply style");
    } finally {
      setBusy(false);
    }
  }, [projectId, path, config, onApplied]);

  const selectedProfile = profiles.find(p => p.id === config.targetStyleId);

  return (
    <div className="reference-style-panel">
      <div className="reference-style-stepper">
        {(["select-style", "configure", "preview", "apply"] as const).map((s, idx) => (
          <div
            key={s}
            className={`reference-style-step ${step === s ? "active" : ""} ${
              ["select-style", "configure", "preview", "apply"].indexOf(step) > idx
                ? "completed"
                : ""
            }`}
          >
            {idx + 1}. {s.replace("-", " ")}
          </div>
        ))}
      </div>

      <div className="reference-style-body">
        {step === "select-style" && (
          <div className="reference-style-step-content">
            <h3>Select Reference Style</h3>
            <Field label="Target Style">
              <Select
                value={config.targetStyleId}
                onChange={(value) =>
                  setConfig((prev) => ({ ...prev, targetStyleId: value }))
                }
                options={profiles.map((p) => ({
                  value: p.id,
                  label: p.name,
                }))}
                placeholder="Choose a style..."
              />
            </Field>
            {selectedProfile && (
              <div className="style-profile-preview">
                <p>{selectedProfile.description}</p>
                <div className="style-features">
                  {selectedProfile.features.map((f) => (
                    <span key={f} className="style-feature-tag">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <Button
              disabled={!config.targetStyleId}
              onClick={() => setStep("configure")}
            >
              Next
            </Button>
          </div>
        )}

        {step === "configure" && (
          <div className="reference-style-step-content">
            <h3>Configure Transfer</h3>
            <Field label="Scope">
              <Select
                value={config.scope}
                onChange={(value) =>
                  setConfig((prev) => ({
                    ...prev,
                    scope: value as "document" | "selection",
                  }))
                }
                options={[
                  { value: "document", label: "Entire Document" },
                  { value: "selection", label: "Current Selection" },
                ]}
              />
            </Field>
            <Field label="Options">
              <label>
                <input
                  type="checkbox"
                  checked={config.preserveCitations}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      preserveCitations: e.target.checked,
                    }))
                  }
                />
                Preserve citations
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.preserveFormatting}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      preserveFormatting: e.target.checked,
                    }))
                  }
                />
                Preserve formatting
              </label>
            </Field>
            <div style={{ display: "flex", gap: "8px" }}>
              <Button variant="secondary" onClick={() => setStep("select-style")}>
                Back
              </Button>
              <Button disabled={busy} onClick={() => void generatePreview()}>
                Generate Preview
              </Button>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="reference-style-step-content">
            <h3>Preview Changes</h3>
            <div className="style-transfer-preview">{preview}</div>
            <div style={{ display: "flex", gap: "8px" }}>
              <Button variant="secondary" onClick={() => setStep("configure")}>
                Back
              </Button>
              <Button disabled={busy} onClick={() => void applyStyle()}>
                Apply Style
              </Button>
            </div>
          </div>
        )}

        {step === "apply" && (
          <div className="reference-style-step-content">
            <h3>Style Applied</h3>
            <p>The reference style has been successfully applied to your document.</p>
            <Button onClick={() => setStep("select-style")}>Start New Transfer</Button>
          </div>
        )}

        {error && <div className="error-message">{error}</div>}
      </div>
    </div>
  );
}
