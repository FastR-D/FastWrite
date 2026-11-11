import { useMemo, useState, type ReactNode } from "react";
import type { PaperProject } from "@fastwrite/shared";
import { publicationTargetAbbreviation } from "../../lib/labels";
import { projectPath } from "../../lib/navigation";
import { Button, Icon, IconButton, Link, Select, Table, TableCell, TableRow, TextField, icons } from "../ui";
import styles from "./ProjectBrowser.module.css";

type SourceFilter = "all" | "local" | "github";
type ProjectSort = "updated" | "oldest" | "name";
const filters = [
  { value: "all", label: "全部项目", icon: icons.files },
  { value: "local", label: "本地项目", icon: icons.folder },
  { value: "github", label: "GitHub 项目", icon: icons.github },
] as const;

interface ProjectBrowserProps {
  projects: PaperProject[];
  loading: boolean;
  error: string;
  deleting: string | null;
  notice: ReactNode;
  onNew: () => void;
  onImport: () => void;
  onTeams: () => void;
  onRetry: () => void;
  onDelete: (project: PaperProject) => void;
}

export function ProjectBrowser({ projects, loading, error, deleting, notice, onNew, onImport, onTeams, onRetry, onDelete }: ProjectBrowserProps) {
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("updated");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProjects = useMemo(() => projects.filter(project => {
    if (source !== "all" && project.source.type !== source) return false;
    const searchable = [project.name, project.mainDocument,
      project.source.type === "github" ? project.source.repository : project.source.displayName,
      publicationTargetAbbreviation(project.publicationTarget, project.skill.id),
    ].join(" ").toLocaleLowerCase();
    return searchable.includes(normalizedQuery);
  }).sort((a, b) => sort === "name"
    ? a.name.localeCompare(b.name, "zh-CN", { numeric: true })
    : (sort === "oldest" ? 1 : -1) * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt))), [projects, source, normalizedQuery, sort]);
  const title = filters.find(filter => filter.value === source)!.label;
  const sourceCount = projects.filter(project => source === "all" || project.source.type === source).length;
  const filtered = source !== "all" || Boolean(normalizedQuery);

  return (
    <div className={styles.browser}>
      <aside className={styles.sidebar} aria-label="项目导航">
        <div className={styles.createActions}>
          <Button className={styles.createButton} variant="primary" icon={<Icon name={icons.add} />} onClick={onNew}>新建论文</Button>
          <Button className={styles.createButton} variant="secondary" icon={<Icon name={icons.cloudUpload} />} onClick={onImport}>导入论文</Button>
        </div>
        <nav className={styles.navigation} aria-label="项目来源">
          <p className={styles.navHeading}>工作区</p>
          {filters.map(filter => <Button
            key={filter.value}
            variant="ghost"
            className={styles.filter}
            aria-current={source === filter.value ? "page" : undefined}
            icon={<Icon name={filter.icon} />}
            onClick={() => setSource(filter.value)}
          >
            <span className={styles.filterLabel}>{filter.label}</span>
            <span className={styles.filterCount}>{loading ? "—" : projects.filter(project => filter.value === "all" || project.source.type === filter.value).length}</span>
          </Button>)}
        </nav>
        <div className={styles.sidebarFooter}>
          <Button variant="ghost" className={styles.teamButton} icon={<Icon name={icons.organization} />} onClick={onTeams}>团队与协作</Button>
          <span>FastWrite 工作区</span>
        </div>
      </aside>

      <main className={styles.main} aria-labelledby="projects-title">
        <header className={styles.heading}>
          <div className={styles.title}>
            <h1 id="projects-title">{title}</h1>
            <span className={styles.total} aria-label={`${sourceCount} 个项目`}>{loading ? "—" : sourceCount}</span>
          </div>
        </header>
        {notice ? <div className={styles.notice}>{notice}</div> : null}
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <Icon name={icons.search} />
            <TextField type="search" aria-label="搜索项目" placeholder="搜索项目、文件或来源…" value={query} onChange={setQuery} />
          </div>
          <div className={styles.sortActions}>
            <Select aria-label="项目排序" value={sort} onChange={value => setSort(value as ProjectSort)} options={[
              { value: "updated", label: "最近修改" },
              { value: "oldest", label: "最早修改" },
              { value: "name", label: "项目名称 A–Z" },
            ]} />
            <IconButton label="刷新项目列表" icon={<Icon name={icons.refresh} spin={loading} />} disabled={loading} onClick={onRetry} />
          </div>
        </div>
        {error ? <div className={`page-error ${styles.error}`} role="alert"><strong>无法加载项目</strong><span>{error}</span><Button size="small" onClick={onRetry}>重试</Button></div> : null}

        {loading ? <div className={styles.loading} role="status" aria-label="正在加载项目">
          <span className={styles.loadingLabel}>正在加载项目…</span>
          {[0, 1, 2, 3, 4].map(item => <div className={styles.skeletonRow} key={item} aria-hidden="true"><i /><i /><i /></div>)}
        </div> : visibleProjects.length ? <Table label="项目列表" className={styles.projectTable!} columns={["项目名称", "来源", "投稿目标 / 领域", "最后修改", "操作"]}>
          {visibleProjects.map(project => <TableRow key={project.id} className={styles.projectRow!}>
            <TableCell>
              <Link variant="inherit" className={styles.projectLink} href={projectPath(project.id)} title={project.name}>
                <Icon name={icons.fileText} size={20} />
                <span className={styles.projectIdentity}>
                  <span className={styles.projectName}>{project.name}</span>
                  <span className={styles.projectDetail}><code>{project.mainDocument}</code><span className={styles.mobileDate}> · {relativeTime(project.updatedAt)}</span></span>
                </span>
              </Link>
            </TableCell>
            <TableCell><span className={styles.source} title={project.source.type === "github" ? project.source.repository : project.source.displayName}>
              <Icon name={project.source.type === "github" ? icons.github : icons.folder} size={14} />
              <span>{project.source.type === "github" ? project.source.repository : "本地项目"}</span>
            </span></TableCell>
            <TableCell><span className={styles.target}>{publicationTargetAbbreviation(project.publicationTarget, project.skill.id)}</span></TableCell>
            <TableCell><time className={styles.updated} dateTime={project.updatedAt} title={new Date(project.updatedAt).toLocaleString("zh-CN")}>{relativeTime(project.updatedAt)}</time></TableCell>
            <TableCell><IconButton className={styles.deleteButton} label={`删除 ${project.name}`} title="将项目移入回收站" icon={<Icon name={deleting === project.id ? icons.loading : icons.trash} spin={deleting === project.id} />} disabled={deleting === project.id} onClick={() => onDelete(project)} /></TableCell>
          </TableRow>)}
        </Table> : !error ? <div className={styles.empty}>
          <Icon name={filtered ? icons.search : icons.files} size={32} />
          <h2>{filtered ? "没有匹配的项目" : "开始你的第一篇论文"}</h2>
          <p>{filtered ? "试试其他关键词，或查看全部项目。" : "新建论文，或导入本地目录与 GitHub 仓库。"}</p>
          {filtered ? <Button variant="secondary" onClick={() => { setQuery(""); setSource("all"); }}>清除筛选</Button> : <Button variant="primary" icon={<Icon name={icons.add} />} onClick={onNew}>新建论文</Button>}
        </div> : null}
        <footer className={styles.footer} role="status">{loading ? "正在同步项目…" : `显示 ${visibleProjects.length} 个项目${filtered ? `，共 ${projects.length} 个` : ""}`}</footer>
      </main>
    </div>
  );
}

function relativeTime(value: string): string {
  const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}
