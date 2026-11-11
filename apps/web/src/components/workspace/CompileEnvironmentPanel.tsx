import { useEffect, useState } from "react";
import { TEX_ENGINES, type CompileSettings, type TexEnvironmentStatus } from "@fastwrite/shared";
import { api } from "../../api/client";
import { userFacingError } from "../../lib/notifications";
import { Alert, Button, Field, List, ListRow, Section, Select, Spinner, Table, TableCell, TableRow, Tag, Text, View } from "../ui";
import styles from "./LatexPanels.module.css";

export function CompileEnvironmentPanel({ projectId, value, onChange }: {
  projectId: string;
  value: CompileSettings;
  onChange: (value: CompileSettings) => void;
}) {
  const [environments, setEnvironments] = useState<TexEnvironmentStatus[]>([]);
  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof api.latex.preflight>> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const refresh = async () => {
    setLoading(true);
    setError("");
    try { setEnvironments(await api.latex.environments()); }
    catch (failure) { setError(userFacingError(failure, "编译环境检查失败")); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { setPreflight(null); }, [projectId, value.engine, value.environmentId]);
  const check = async () => {
    setChecking(true);
    setPreflight(null);
    setError("");
    try { setPreflight(await api.latex.preflight(projectId)); }
    catch (failure) { setError(userFacingError(failure, "项目依赖检查失败")); }
    finally { setChecking(false); }
  };
  const environment = environments.find(item => item.id === value.environmentId);
  const options = environments.map(item => ({ value: item.id, label: item.label }));
  if (!environment) options.unshift({ value: value.environmentId, label: value.environmentId });
  return <View className={styles.stack ?? ""}>
    <Field label="TeX 引擎"><Select value={value.engine} onChange={engine => onChange({ ...value, engine: engine as CompileSettings["engine"] })} options={TEX_ENGINES.map(engine => ({ value: engine, label: engine }))} /></Field>
    <Field label="服务器环境"><Select value={value.environmentId} onChange={environmentId => onChange({ ...value, environmentId })} options={options} /></Field>
    <View className={styles.row ?? ""}>
      <Button variant="secondary" disabled={loading} loading={loading} onClick={() => void refresh()}>重新检查环境</Button>
      <Button variant="ghost" disabled={checking} loading={checking} onClick={() => void check()}>检查已保存项目的宏包依赖</Button>
    </View>
    <Text tone="muted" size="small">修改引擎或环境后，请先保存更改，再检查项目依赖。</Text>
    {loading ? <View className={styles.row ?? ""}><Spinner label="正在检查服务器环境" /><Text tone="muted">正在检查服务器环境…</Text></View> : null}
    {error ? <Alert tone="error">{error}</Alert> : null}
    {environment ? <Section title={environment.label} headingLevel={3} surface actions={<Tag tone={environment.ready ? "success" : "warning"}>{environment.ready ? "可用" : "依赖不完整"}</Tag>}>
      <Table label="TeX 引擎安装状态" columns={["引擎", "状态", "版本"]}>
        {environment.engines.map(engine => <TableRow key={engine.engine}>
          <TableCell header>{engine.engine}</TableCell>
          <TableCell><Tag tone={engine.available ? "success" : "warning"}>{engine.available ? "已安装" : "未安装"}</Tag></TableCell>
          <TableCell><Text tone="muted" size="small">{engine.version ?? "—"}</Text></TableCell>
        </TableRow>)}
      </Table>
      <View className={styles.row ?? ""}>
        {environment.tools.map(tool => <Tag key={tool.name} tone={tool.available ? "neutral" : "warning"}>{`${tool.name} · ${tool.available ? "已安装" : "缺失"}`}</Tag>)}
        <Tag tone={environment.sandboxAvailable ? "neutral" : "warning"}>{`编译沙箱 · ${environment.sandboxAvailable ? "已安装" : "未安装"}`}</Tag>
      </View>
    </Section> : !loading && !error ? <Alert tone="warning">当前服务器未提供所选环境，请选择其他环境或联系管理员配置。</Alert> : null}
    {preflight ? <Section title="项目依赖" headingLevel={3} surface>
      <Alert tone={preflight.missing.length ? "warning" : "success"}>{preflight.missing.length ? `缺少 ${preflight.missing.length} 个宏包或文档类` : "依赖检查完成"}</Alert>
      {preflight.dependencies.length ? <List label="宏包和文档类依赖">
        {preflight.dependencies.map(dep => <ListRow key={dep.file} className={styles.statusRow ?? ""}>
          <Text mono>{dep.file}</Text><Tag tone={dep.status === "missing" ? "warning" : "neutral"}>{dep.status === "missing" ? "缺失" : dep.status === "installed" ? "已安装" : dep.status === "project" ? "项目提供" : "待确认"}</Tag>
        </ListRow>)}
      </List> : <Text tone="muted">未发现需要检查的宏包或文档类。</Text>}
      {preflight.warnings.map(warning => <Alert key={warning} tone="warning">{warning}</Alert>)}
    </Section> : null}
  </View>;
}
