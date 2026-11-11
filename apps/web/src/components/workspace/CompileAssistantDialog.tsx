import { statusLabel } from "../../lib/labels";
import { useEffect, useRef, useState } from "react";
import type { ChangeSet, LatexDiagnostic } from "@fastwrite/shared";
import { api } from "../../api/client";
import { userFacingError } from "../../lib/notifications";
import { Alert, Button, Checkbox, Dialog, Disclosure, Field, List, ListRow, Section, Select, Spinner, Stepper, Tag, Text, TextArea, View } from "../ui";
import styles from "./LatexPanels.module.css";
import { EditableChangeReview } from "./EditableChangeReview";

export function CompileAssistantDialog({
  open,
  projectId,
  initialLightweight,
  initialDiagnosticId,
  diagnostics,
  beforeRun,
  onAccepted,
  onClose,
}: {
  open: boolean;
  projectId: string;
  initialLightweight: boolean;
  initialDiagnosticId?: string;
  diagnostics: LatexDiagnostic[];
  beforeRun: () => Promise<void>;
  onAccepted: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [objective, setObjective] = useState(
    "检查当前项目的编译结果，按错误定位源码并提出最小修改，再重新编译验证。",
  );
  const [lightweight, setLightweight] = useState(initialLightweight),
    [diagnosticId, setDiagnosticId] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [explanation, setExplanation] = useState("");
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null),
    [validated, setValidated] = useState(false),
    [steps, setSteps] = useState<string[]>([]);
  const [resultDiagnostics, setResultDiagnostics] = useState<LatexDiagnostic[]>(
    [],
  );
  const [pending, setPending] = useState<ChangeSet[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;
    setLightweight(initialLightweight);
    setDiagnosticId(initialDiagnosticId ?? "");
    setError("");
    void api.latex
      .proposals(projectId)
      .then(setPending)
      .catch(() => setPending([]));
  }, [open, projectId, initialLightweight, initialDiagnosticId]);
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => {
    controller.current?.abort();
    onClose();
  };
  const run = async () => {
    setBusy(true);
    setError("");
    setExplanation("");
    setSteps([]);
    setChangeSet(null);
    setValidated(false);
    setResultDiagnostics([]);
    const abort = new AbortController();
    controller.current = abort;
    try {
      await beforeRun();
      const project = await api.projects.get(projectId, abort.signal);
      const output = await api.latex.assistant(
        projectId,
        {
          expectedVersion: project.version,
          objective,
          lightweight,
          ...(diagnosticId ? { diagnosticId } : {}),
        },
        abort.signal,
      );
      setExplanation(output.explanation);
      setChangeSet(output.changeSet ?? null);
      setValidated(output.validated);
      setSteps(
        output.steps.map(
          (step) =>
            ({
              read_file: "读取源码",
              propose_edit: "生成修改候选",
              compile: "编译验证",
              finish: "完成检查",
            })[step.action] ?? "检查",
        ),
      );
      setResultDiagnostics(output.diagnostics);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(userFacingError(failure, "编译助手未完成，正文未改动"));
    } finally {
      setBusy(false);
    }
  };
  const decide = async (action: "accept" | "reject") => {
    if (!changeSet) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api.revisions[action](projectId, changeSet.id);
      setChangeSet(updated);
      if (action === "accept")
        for (const file of updated.changes) await onAccepted(file.path);
      setPending((items) => items.filter((item) => item.id !== updated.id));
    } catch (failure) {
      setError(
        userFacingError(failure, "候选与当前正文冲突，请核对后重新生成"),
      );
    } finally {
      setBusy(false);
    }
  };
  const decideHunks = async (
    path: string,
    hunkIds: string[],
    status: "accepted" | "rejected",
  ) => {
    if (!changeSet) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api.revisions.decide(projectId, changeSet.id, {
        decisions: [{ path, hunkIds, status }],
      });
      setChangeSet(updated);
      setValidated(false);
      await onAccepted(path);
    } catch (failure) {
      setError(userFacingError(failure, "审核修改失败"));
    } finally {
      setBusy(false);
    }
  };
  const reviewable = changeSet && ["proposed", "partially-accepted"].includes(changeSet.status);
  return (
    <Dialog
      open={open}
      title="编译助手与待审核修改"
      description="读取源码和编译诊断，在隔离副本中验证候选，接受后写入正文。"
      width="wide"
      onClose={close}
      footer={<>
        <View className={`${styles.row} ${styles.footerHint}`}>
          {changeSet ? <Tag>{statusLabel(changeSet.status)}</Tag> : null}
          <Text tone="muted">{busy ? "正在处理…" : changeSet ? `${changeSet.changes.length} 个文件` : "生成候选后可在此审核"}</Text>
        </View>
        {busy ? <Button variant="ghost" onClick={() => controller.current?.abort()}>停止</Button> : null}
        {reviewable ? <>
          <Button disabled={busy} variant="ghost" onClick={() => void decide("reject")}>拒绝剩余修改</Button>
          <Button variant="primary" disabled={busy} onClick={() => void decide("accept")}>接受修改</Button>
        </> : <Button variant="primary" disabled={busy || !objective.trim()} loading={busy} onClick={() => void run()}>检查并生成候选</Button>}
      </>}
    >
      <View className={styles.stack ?? ""}>
        {pending.length ? (
          <Field label="恢复待审核候选（含外部 MCP）">
            <Select disabled={busy} value={changeSet?.id ?? ""} onChange={(id) => {
              setChangeSet(pending.find((item) => item.id === id) ?? null);
              setValidated(false);
              setExplanation("");
              setSteps([]);
              setResultDiagnostics([]);
            }} options={[{ value: "", label: "选择候选" }, ...pending.map((item) => ({ value: item.id, label: item.summary }))]} />
          </Field>
        ) : null}
        <Section title="检查任务" headingLevel={3} description="选择单条错误修复，或让助手继续检查整个项目。"
          actions={changeSet ? <Button variant="secondary" disabled={busy || !objective.trim()} onClick={() => void run()}>重新检查</Button> : undefined}>
          <Field label="任务"><TextArea value={objective} onChange={setObjective} disabled={busy} rows={2} /></Field>
          <Checkbox checked={lightweight} disabled={busy} onChange={setLightweight}>单条错误最小修复（仅修改一个文件，候选必须通过编译）</Checkbox>
          {lightweight ? <Field label="错误定位">
            <Select disabled={busy} value={diagnosticId} onChange={setDiagnosticId} options={[
              { value: "", label: "当前编译的第一个错误" },
              ...diagnostics.filter((item) => item.severity === "error").map((item) => ({ value: item.id, label: `${item.path ?? ""}:${item.line ?? ""} ${item.message}` })),
            ]} />
          </Field> : null}
        </Section>
        {busy ? <View className={styles.row ?? ""}><Spinner label="编译助手正在处理" /><Text tone="muted">正在读取源码并验证编译结果…</Text></View> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {steps.length ? <Disclosure summary={`执行记录 · ${steps.length} 步`}>
          <Stepper label="编译助手执行记录" steps={steps.map((label, index) => ({ id: String(index), label, status: "complete" }))} numbered />
        </Disclosure> : null}
        {explanation ? <Alert tone="info" title="检查说明">{explanation}</Alert> : null}
        {resultDiagnostics.length ? <Disclosure summary={`编译诊断 · ${resultDiagnostics.length}`} defaultOpen={!validated}>
          <List label="编译诊断">
            {resultDiagnostics.map((item) => <ListRow key={item.id} className={styles.citationRow ?? ""}>
              <Tag tone={item.severity === "error" ? "danger" : "warning"}>{item.severity === "error" ? "错误" : "提示"}</Tag>
              <Text>{item.message}</Text>
              <Text tone="muted" size="small" mono>{[item.path, item.line].filter(value => value != null).join(":") || "项目编译"}</Text>
            </ListRow>)}
          </List>
        </Disclosure> : null}
        {changeSet ? <>
          <Alert tone={validated ? "success" : "info"} role="status">{validated ? "候选已在当前项目快照中编译通过" : "请审核候选及编译诊断"}</Alert>
          {changeSet.changes.map((change) => <Section key={change.path} title={change.path} headingLevel={3} surface className={styles.review ?? ""}>
            <EditableChangeReview change={change} busy={busy} readOnly={["accepted", "rejected", "rolled-back"].includes(changeSet.status)} onDecide={(ids, status) => void decideHunks(change.path, ids, status)} />
          </Section>)}
        </> : null}
      </View>
    </Dialog>
  );
}
