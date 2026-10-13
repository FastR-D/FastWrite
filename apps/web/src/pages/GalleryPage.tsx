import { useState } from "react";
import {
  Alert, Badge, Button, Checkbox, Disclosure, Divider, EmptyState, Field, FileField, Icon, IconButton, icons,
  Label, Link, List, ListEmpty, ListRow, ListRowText, Loader, MultiSelect, NumberField, ProgressBar,
  SegmentedControl, Select, Spinner, StatusBar, StatusItem, Table, TableCell, TableRow,
  Tag, TextArea, TextField, Tooltip, View
} from "../components/ui";
import styles from "./GalleryPage.module.css";

const PROJECTS = [
  { value: "alpha", label: "甲项目" },
  { value: "beta", label: "乙项目" },
  { value: "gamma", label: "丙项目" },
  // Kept last so the interaction swatches above are unaffected by it.
  { value: "archived", label: "已归档（只读）", disabled: true }
];

const PUBLICATIONS = [
  { label: "CCF A 类会议", options: [{ value: "ccs", label: "CCS" }, { value: "sp", label: "S&P" }] },
  { label: "CCF A 类期刊", options: [{ value: "tifs", label: "TIFS" }, { value: "tdsc", label: "TDSC" }] }
];

/*
 * Twelve entries, so `searchable` engages on its own default (more than 10
 * options). This is the only catalogue entry that exercises the filter field —
 * and with it the editable-combobox path where the role moves onto the input.
 */
const CITY_VENUES = [
  "Aarhus", "Berlin", "Chicago", "Dresden", "Edinburgh", "Florence",
  "Geneva", "Helsinki", "Istanbul", "Jakarta", "Kyoto", "Lisbon"
].map((city, index) => ({ value: city.toLowerCase(), label: ["奥胡斯", "柏林", "芝加哥", "德累斯顿", "爱丁堡", "佛罗伦萨", "日内瓦", "赫尔辛基", "伊斯坦布尔", "雅加达", "京都", "里斯本"][index]! }));

export function GalleryPage() {
  const [project, setProject] = useState("");
  const [publication, setPublication] = useState("");
  const [city, setCity] = useState("");
  const [skills, setSkills] = useState<string[]>(["draft"]);
  const [size, setSize] = useState<number | undefined>(120);
  const [agree, setAgree] = useState(false);
  const [name, setName] = useState("安全系统论文");
  const [outlineMode, setOutlineMode] = useState<"current" | "project">("current");
  const [sizeMode, setSizeMode] = useState<"small" | "medium" | "wide">("medium");

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>FastWrite 界面组件</h1>
          <div className={styles.subtitle}>组件目录 · 基于 vscrui</div>
        </div>
        <Button variant="ghost" size="small" onClick={() => { window.location.assign("/"); }}>返回项目列表</Button>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>按钮</h2>
        <p className={styles.sectionNote}>每个区域只保留一个主要操作，纯图标按钮均提供无障碍名称。</p>
        <div className={styles.row}>
          <Button variant="primary">主要按钮</Button>
          <Button variant="secondary">次要按钮</Button>
          <Button variant="ghost">简洁按钮</Button>
          <Button variant="danger">危险操作</Button>
          <Button variant="primary" loading>正在保存</Button>
          <Button disabled>已禁用</Button>
        </div>
        <div className={styles.row}>
          <Button variant="secondary" size="small">小尺寸</Button>
          <IconButton label="搜索项目" icon={<Icon name={icons.search} />} />
          <IconButton label="删除草稿" variant="danger" icon={<Icon name={icons.trash} />} />
          <IconButton label="刷新" variant="secondary" icon={<Icon name={icons.refresh} />} />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>文本输入</h2>
        <p className={styles.sectionNote}>字段统一管理标签、提示和错误之间的关联，包括 aria-describedby。</p>
        <div className={styles.column}>
          <Field label="项目名称" hint="显示在项目列表中。">
            {({ id, describedBy, invalid }) => (
              <TextField id={id} aria-describedby={describedBy} invalid={invalid} value={name} onChange={setName} />
            )}
          </Field>
          <Field label="工作区路径" error="请使用此工作区内的路径。">
            {({ id, describedBy, invalid }) => (
              <TextField id={id} aria-describedby={describedBy} invalid={invalid} defaultValue="../escape.tex" />
            )}
          </Field>
          <Field label="摘要" hint="支持 Markdown 和 LaTeX。">
            {({ id, describedBy }) => (
              <TextArea id={id} aria-describedby={describedBy} rows={3} defaultValue="我们提出…" />
            )}
          </Field>
          <Field label="正文页数" error="此会议或期刊要求正文不超过 12 页。">
            {({ id, describedBy, invalid }) => (
              <NumberField id={id} aria-describedby={describedBy} invalid={invalid} value={size} onChange={setSize} min={1} step={1} />
            )}
          </Field>
          <Field label="模板文件" error="仅支持 .tex 模板。">
            {({ id, describedBy, invalid }) => (
              <FileField id={id} label="模板文件" aria-describedby={describedBy} invalid={invalid} accept=".tex" onSelect={() => undefined} />
            )}
          </Field>
          <div className={styles.row}>
            <Label htmlFor="gallery-inline">行内标签</Label>
            <NumberField aria-label="优先级" compact defaultValue={3} min={0} />
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>选择</h2>
        <p className={styles.sectionNote}>
          自定义组合框支持方向键、Home、End、输入匹配和 Esc。选项超过 10 个时显示筛选框。
        </p>
        <div className={styles.column}>
          <Field label="项目">
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} aria-label="项目" options={PROJECTS} value={project} onChange={setProject} placeholder="选择项目" />
            )}
          </Field>
          <Field label="投稿目标" hint="以带标签的分组显示。">
            {({ id }) => (
              <Select id={id} aria-label="投稿目标" options={PUBLICATIONS} value={publication} onChange={setPublication} placeholder="选择会议或期刊" />
            )}
          </Field>
          <Field label="长列表" hint="选项超过 10 个，已启用筛选框。">
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} aria-label="长列表" options={CITY_VENUES} value={city} onChange={setCity} placeholder="选择城市" />
            )}
          </Field>
          <Field label="任务技能" hint="应用于下一次技能运行。">
            {({ describedBy, invalid }) => (
              <MultiSelect
                label="任务技能"
                aria-describedby={describedBy}
                invalid={invalid}
                value={skills}
                onChange={setSkills}
                options={[
                  { value: "draft", label: "起草 · 生成初稿" },
                  { value: "continue", label: "续写 · 补充待完成章节" },
                  { value: "revise", label: "修改 · 处理审稿意见" }
                ]}
              />
            )}
          </Field>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>选择与状态</h2>
        <div className={styles.row}>
          {/*
           * A checkbox with no text of its own is exactly what Field's render
           * prop is for: the label names it through `id`, the error describes it
           * through `describedBy`, and both invalid flags come along.
           */}
          <Field label="投稿规则" error={agree ? undefined : "请先确认投稿规则，再编译。"}>
            {({ id, describedBy, invalid }) => (
              <Checkbox id={id} checked={agree} onChange={setAgree} aria-describedby={describedBy} invalid={invalid} />
            )}
          </Field>
          <Checkbox variant="pill" icon={<Icon name={icons.sparkle} />} checked={agree} onChange={setAgree}>补全</Checkbox>
        </div>
        <div className={styles.row}>
          <Tag tone="success">已编译</Tag>
          <Tag tone="danger">版本已更改</Tag>
          <Tag tone="warning">已过期</Tag>
          <Tag tone="info">审核中</Tag>
          <Badge label="3 个未解决问题">3</Badge>
        </div>
        <div className={styles.row}>
          <Spinner label="正在加载模板" />
          <Loader overlay={false} message="正在准备" />
          <Divider orientation="vertical" />
          <Icon name={icons.gitCompare} />
          <Icon name={icons.loading} spin />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>反馈</h2>
        <div className={styles.column}>
          <Alert tone="success">编译成功。</Alert>
          <Alert tone="error" title="文件版本已更改">请重新加载后再保存。</Alert>
          <Alert tone="warning">部分投稿规则无法检查。</Alert>
          <Alert tone="info" actions={<Button size="small">重试</Button>}>正在应用投稿规则…</Alert>
        </div>
        <div className={styles.column} style={{ marginTop: 14 }}>
          <ProgressBar label="正在加载 TeX 资源包" value={68} detail="34.4 MB / 50.6 MB · core.data.gz" />
          <ProgressBar label="正在编译" />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>表格</h2>
        <p className={styles.sectionNote}>使用标准表格，使辅助技术能识别行和列标题。</p>
        <Table label="最近审计事件" columns={["时间", "操作", "资源", "操作人"]} stripped>
          <TableRow>
            <TableCell>2026-09-18 09:14</TableCell>
            <TableCell>创建项目</TableCell>
            <TableCell>项目</TableCell>
            <TableCell>系统</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>2026-09-18 09:31</TableCell>
            <TableCell>邀请成员</TableCell>
            <TableCell>用户</TableCell>
            <TableCell>owner@example.edu</TableCell>
          </TableRow>
        </Table>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>空状态与提示</h2>
        <p className={styles.sectionNote}>悬停或键盘聚焦时显示提示，按 Esc 可关闭。</p>
        <div className={styles.row}>
          <EmptyState
            title="暂无审稿问题"
            detail="当前版本准备就绪后开始审稿。"
            action={<Button size="small">开始审稿</Button>}
          />
        </div>
        <div className={styles.row} style={{ marginTop: 14 }}>
          <Tooltip content="Explains a compact icon action">
            <IconButton label="更多信息" icon={<Icon name={icons.info} />} />
          </Tooltip>
          <Tooltip content="Shown below when there is no room above" side="bottom">
            <Button size="small" variant="secondary">悬停或聚焦以查看</Button>
          </Tooltip>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>图标</h2>
        <p className={styles.sectionNote}>
          图标默认仅作装饰，由周围控件提供名称。具有独立含义的图标提供 aria-label，以便辅助技术识别。
        </p>
        <div className={styles.row}>
          {/* Decorative: hidden, because the button's own label names it. */}
          <IconButton label="搜索项目" icon={<Icon name={icons.search} />} />
          {/* Labelled: exposed as an image with a name, since nothing else names it. */}
          <Icon name={icons.error} aria-label="编译错误" />
          <Icon name={icons.verified} aria-label="已核实的证据" />
          <Icon name={icons.fileText} />
          <Icon name={icons.loading} spin />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>视图</h2>
        <div className={styles.row}>
          <View aria-label="始终显示" className={styles.grid ?? ""}>默认显示</View>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>界面框架</h2>
        <p className={styles.sectionNote}>包括导航、分组、展开区域和状态栏。</p>

        <div className={styles.row}>
          <Link href="/projects">内部链接</Link>
          <Link href="#gallery-anchor">页面锚点</Link>
          <Link href="https://example.com" rel="noreferrer noopener" target="_blank">外部链接</Link>
          <Link href="/api/health" variant="button" download="health.json">下载按钮</Link>
        </div>

        <div className={styles.row}>
          <SegmentedControl
            label="大纲来源"
            value={outlineMode}
            onChange={setOutlineMode}
            options={[
              { value: "current", label: "当前文档" },
              { value: "project", label: "项目结构" }
            ]}
          />
          <SegmentedControl
            label="对话框尺寸"
            bordered
            value={sizeMode}
            onChange={setSizeMode}
            options={[
              { value: "small", label: "S" },
              { value: "medium", label: "M" },
              { value: "wide", label: "L" }
            ]}
          />
        </div>

        <div className={styles.column} style={{ marginTop: 14 }}>
          <Disclosure summary="审查覆盖情况 · 3 个服务">
            <p>在此显示服务、输入范围及各审查阶段的问题数量。</p>
          </Disclosure>
          <List label="当前更改文件" compact>
            <ListRow onClick={() => undefined} selected><ListRowText primary="main.tex" secondary="已修改" /></ListRow>
            <ListRow onClick={() => undefined}><ListRowText primary="sections/method.tex" secondary="已添加" /></ListRow>
            <ListRow><ListRowText primary="refs.bib" secondary="二进制文件" /></ListRow>
            <ListEmpty>没有其他更改</ListEmpty>
          </List>
        </div>

        <div style={{ marginTop: 18 }}>
          <StatusBar label="工作区状态" className="workbench-status">
            <StatusItem>托管历史</StatusItem>
            <StatusItem>本地项目</StatusItem>
            <StatusItem>编辑内容已确认</StatusItem>
            <StatusItem trailing>第 1 行，第 1 列</StatusItem>
          </StatusBar>
        </div>
      </section>
    </main>
  );
}
