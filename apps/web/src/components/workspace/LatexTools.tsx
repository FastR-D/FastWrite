import { useEffect, useMemo, useRef, useState } from "react";
import {
  citationSlot,
  searchBibliography,
  type BibEntry,
  type LatexIndex,
} from "@fastwrite/shared";
import * as monaco from "../../lib/editor/monacoRuntime";
import type { LatexIntelligence } from "../../lib/editor/latexIntelligence";
import { TEX_SYMBOLS } from "../../lib/editor/latexCatalog";
import { Alert, Badge, Button, Checkbox, Dialog, Disclosure, EmptyState, Field, List, ListRow, Spinner, Tag, Text, TextField, View } from "../ui";
import styles from "./LatexPanels.module.css";
import { userFacingError } from "../../lib/notifications";

export function LatexTools({
  editor,
  intelligence,
  editable,
}: {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  intelligence: LatexIntelligence | null;
  editable: boolean;
}) {
  const [open, setOpen] = useState(false),
    [symbolsOpen, setSymbolsOpen] = useState(false),
    [query, setQuery] = useState("");
  const [index, setIndex] = useState<LatexIndex | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const capture = useRef<{
    model: monaco.editor.ITextModel;
    version: number;
    range: monaco.Range;
    existing: boolean;
  } | null>(null);
  const load = async () => {
    if (!editor || !intelligence || !editable) return;
    const model = editor.getModel(),
      selection = editor.getSelection();
    if (!model || !selection) return;
    const cursor = model.getOffsetAt(selection.getPosition()),
      slot = citationSlot(model.getValue(), cursor);
    const from = slot
        ? model.getPositionAt(slot.from)
        : selection.getStartPosition(),
      to = slot ? model.getPositionAt(slot.to) : selection.getEndPosition();
    capture.current = {
      model,
      version: model.getVersionId(),
      range: new monaco.Range(
        from.lineNumber,
        from.column,
        to.lineNumber,
        to.column,
      ),
      existing: Boolean(slot),
    };
    setSelected(slot?.keys ?? []);
    setQuery("");
    setError("");
    setIndex(null);
    setOpen(true);
    setBusy(true);
    try {
      setIndex(await intelligence.index(true));
    } catch (failure) {
      setError(userFacingError(failure, "无法加载项目参考文献"));
    } finally {
      setBusy(false);
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!editor) return;
    const action = editor.addAction({
      id: "fastwrite.insertCitation",
      label: "插入或编辑引用",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC,
      ],
      contextMenuGroupId: "navigation",
      run: () => loadRef.current(),
    });
    const symbols = editor.addAction({
      id: "fastwrite.insertSymbol",
      label: "插入数学符号",
      contextMenuGroupId: "navigation",
      run: () => { if (!editor.getOption(monaco.editor.EditorOption.readOnly)) setSymbolsOpen(true); },
    });
    return () => { action.dispose(); symbols.dispose(); };
  }, [editor]);
  const entries = useMemo(
    () => searchBibliography(index?.entries ?? [], query),
    [index, query],
  );
  const duplicates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of index?.entries ?? [])
      counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
    return new Set(
      [...counts].filter(([, count]) => count > 1).map(([key]) => key),
    );
  }, [index]);
  const apply = async () => {
    if (!capture.current || !editor || !intelligence || !editable) return;
    setBusy(true);
    setError("");
    try {
      const latest = await intelligence.index(true),
        captured = capture.current;
      if (
        captured.model.isDisposed() ||
        editor.getModel() !== captured.model ||
        captured.model.getVersionId() !== captured.version ||
        !intelligence.current(captured.model.uri.path.slice(1))
      )
        throw new Error("正文或选区所属文件已变化，请关闭后重新选择引用。");
      const counts = new Map<string, number>();
      for (const entry of latest.entries)
        counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
      for (const key of selected)
        if (counts.get(key) !== 1)
          throw new Error(`引用 ${key} 已移除或存在重复，请重新加载后选择。`);
      const text = selected.join(", ");
      editor.pushUndoStop();
      editor.executeEdits("fastwrite.citation", [
        {
          range: captured.range,
          text: captured.existing ? text : `\\cite{${text}}`,
          forceMoveMarkers: true,
        },
      ]);
      editor.pushUndoStop();
      setOpen(false);
      editor.focus();
    } catch (failure) {
      setError(userFacingError(failure, "引用插入失败"));
    } finally {
      setBusy(false);
    }
  };
  const insertSymbol = (latex: string) => {
    const range = editor?.getSelection();
    if (!editor || !range || !editable) return;
    editor.pushUndoStop();
    editor.executeEdits("fastwrite.symbol", [
      { range, text: latex + " ", forceMoveMarkers: true },
    ]);
    editor.pushUndoStop();
    setSymbolsOpen(false);
    editor.focus();
  };
  return (
    <>
      <Dialog
        open={open}
        title="插入或编辑引用"
        description="搜索项目 BibTeX 的标题、作者、年份、DOI 或引用标识；支持多选。"
        width="large"
        onClose={() => setOpen(false)}
        footer={<>
          <Text tone="muted" className={styles.footerHint ?? ""}>{`已选择 ${selected.length} 篇文献`}</Text>
          <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!index || busy || !selected.length} onClick={() => void apply()}>插入所选引用</Button>
        </>}
      >
        <View className={styles.stack ?? ""}>
          <Field label="检索文献">
            <TextField value={query} onChange={setQuery} placeholder="例如：Smith 2024 或 DOI" autoFocus />
          </Field>
          {busy ? <View className={styles.row ?? ""}><Spinner label="正在核对项目文献" /><Text tone="muted">正在核对项目文献…</Text></View> : null}
          {index?.diagnostics.length ? (
            <Disclosure summary={`文献解析提示 · ${index.diagnostics.length}`}>
              <List label="文献解析提示">
                {index.diagnostics.map((item, i) => <ListRow key={i} className={styles.citationRow ?? ""}><Text>{item.message}</Text><Text tone="muted" size="small" mono>{`${item.path}:${item.line}`}</Text></ListRow>)}
              </List>
            </Disclosure>
          ) : null}
          {selected.length ? <View className={styles.row ?? ""}><Badge label="已选文献数">{selected.length}</Badge>{selected.map(key => <Tag key={key}>{key}</Tag>)}</View> : null}
          {entries.length ? (
            <List label="检索结果" className={styles.citationList ?? ""}>
              {entries.slice(0, 200).map((entry: BibEntry) => (
                <ListRow key={`${entry.path}:${entry.line}:${entry.key}`} className={styles.citationRow ?? ""}>
                  <Checkbox checked={selected.includes(entry.key)} disabled={busy || duplicates.has(entry.key)} onChange={(checked) => setSelected((keys) => checked ? [...keys, entry.key] : keys.filter((key) => key !== entry.key))}>
                    {entry.fields.title || entry.key}
                  </Checkbox>
                  <Text tone="muted" size="small">{[entry.fields.author, entry.fields.year || entry.fields.date].filter(Boolean).join(" · ")}</Text>
                  <View className={styles.row ?? ""}>
                    <Tag>{entry.key}</Tag>
                    <Text tone="muted" size="small" mono>{`${entry.path}:${entry.line}`}</Text>
                    {duplicates.has(entry.key) ? <Tag tone="warning">重复标识，禁止插入</Tag> : null}
                  </View>
                </ListRow>
              ))}
            </List>
          ) : !busy && !error ? <EmptyState title="没有匹配的文献" detail="请调整搜索词，上传 .bib 文件，或在“文献与证据”中审核后添加 BibTeX。" /> : null}
          {entries.length > 200 ? <Alert tone="info">仅显示前 200 条结果，请输入更多关键词缩小范围。</Alert> : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
        </View>
      </Dialog>
      <Dialog open={symbolsOpen} title="数学符号" description="在当前光标处插入 LaTeX 命令。" onClose={() => setSymbolsOpen(false)}>
        <View className={styles.symbols ?? ""}>
          {TEX_SYMBOLS.map((symbol) => <Button key={symbol.latex} variant="secondary" title={symbol.latex} onClick={() => insertSymbol(symbol.latex)}>{symbol.name}</Button>)}
        </View>
      </Dialog>
    </>
  );
}
