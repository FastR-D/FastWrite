import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { userFacingError } from "../../lib/notifications";
import { Alert, Button, EmptyState, Field, List, ListRow, MultiSelect, Section, Spinner, Tag, Text, TextArea, TextField, View } from "../ui";
import styles from "./LatexPanels.module.css";
const SCOPE_LABELS: Record<string, string> = { read: "读取项目", propose: "提出修改", compile: "编译", comment: "回复讨论" };

export function McpSettingsPanel({ projectId }: { projectId: string }) {
  const [tokens, setTokens] = useState<
      Awaited<ReturnType<typeof api.latex.tokens>>
    >([]),
    [name, setName] = useState("本地 AI 客户端"),
    [scopes, setScopes] = useState(["read"]),
    [secret, setSecret] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const load = () => api.latex.tokens(projectId).then(setTokens);
  useEffect(() => {
    setSecret("");
    setError("");
    setLoading(true);
    void load().catch((failure) =>
      setError(userFacingError(failure, "项目所有者可管理 MCP 令牌")),
    ).finally(() => setLoading(false));
  }, [projectId]);
  const create = async () => {
    setBusy(true);
    setError("");
    setSecret("");
    try {
      const output = await api.latex.createToken(projectId, {
        name,
        scopes,
        days: 30,
      });
      setSecret(output.token);
      await load();
    } catch (failure) {
      setError(userFacingError(failure, "无法创建连接令牌"));
    } finally {
      setBusy(false);
    }
  };
  const endpoint = `${window.location.origin}/api/projects/${projectId}/mcp`;
  return (
    <View className={styles.stack ?? ""}>
      <Field label="MCP 地址" hint="在外部客户端选择 Streamable HTTP 连接。">
        <TextField value={endpoint} readonly />
      </Field>
      <Section title="创建连接" headingLevel={3} surface description="令牌限定于此项目，有效期为 30 天。">
        <Field label="连接名称"><TextField value={name} onChange={setName} disabled={busy} /></Field>
        <Field label="连接权限" hint="读取为基础权限，其余权限按需开启。文件修改将进入“编译助手与待审核修改”。">
          <MultiSelect label="连接权限" value={scopes} onChange={setScopes} options={Object.entries(SCOPE_LABELS).map(([value, label]) => ({ value, label, disabled: value === "read" || busy }))} />
        </Field>
        <View className={styles.row ?? ""}><Button variant="primary" disabled={busy || !name.trim()} loading={busy} onClick={() => void create()}>创建 30 天连接令牌</Button></View>
      </Section>
      {secret ? <Section title="客户端配置" headingLevel={3} surface actions={<Button variant="ghost" onClick={() => setSecret("")}>隐藏令牌</Button>}>
        <Alert tone="info">令牌仅显示一次，请保存在客户端配置中。</Alert>
        <Field label="Bearer 令牌"><TextField value={secret} readonly /></Field>
        <Field label="MCP 客户端 JSON 配置" hint="复制以下配置到支持远程 MCP 的客户端。">
          <TextArea className={styles.code ?? ""} rows={12} readonly spellCheck={false} resize="vertical" value={JSON.stringify({ mcpServers: { fastwrite: { url: endpoint, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2)} />
        </Field>
      </Section> : null}
      <Section title="已有连接" headingLevel={3}>
        {loading ? <View className={styles.row ?? ""}><Spinner label="正在加载连接" /><Text tone="muted">正在加载连接…</Text></View> : null}
        {tokens.length ? <List label="MCP 连接">
          {tokens.map((token) => <ListRow key={token.id} className={styles.tokenRow ?? ""}>
            <View className={styles.tokenInfo ?? ""}>
              <Text>{token.name}</Text>
              <Text tone="muted" size="small">{`到期 ${new Date(token.expiresAt).toLocaleDateString()}`}</Text>
              <View className={styles.row ?? ""}>{token.scopes.map(scope => <Tag key={scope}>{SCOPE_LABELS[scope] ?? scope}</Tag>)}</View>
            </View>
            {token.revokedAt ? <Tag>已撤销</Tag> : <View className={styles.row ?? ""}>
              <Tag tone={Date.parse(token.expiresAt) <= Date.now() ? "warning" : "success"}>{Date.parse(token.expiresAt) <= Date.now() ? "已过期" : "有效"}</Tag>
              <Button disabled={busy} variant="ghost" onClick={() => {
                setBusy(true);
                setError("");
                void api.latex.revokeToken(projectId, token.id).then(load).catch((failure) => setError(userFacingError(failure, "撤销失败"))).finally(() => setBusy(false));
              }}>撤销</Button>
            </View>}
          </ListRow>)}
        </List> : !loading && !error ? <EmptyState title="暂无外部连接" detail="创建令牌后，即可将外部客户端连接到此项目。" /> : null}
      </Section>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </View>
  );
}
