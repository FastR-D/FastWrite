import { Button, Icon, Link, List, ListRow, ThemeToggle, icons } from "../ui";
import styles from "./ProductLanding.module.css";

const tools = [
  { icon: icons.fileText, title: "编辑与预览", description: "编辑 LaTeX 源文件，查看 PDF，双向定位正文。" },
  { icon: icons.book, title: "参考论文", description: "添加 PDF 或 TeX 压缩包，参考全文或指定章节的写法。" },
  { icon: icons.sparkle, title: "AI 写作", description: "起草、续写、修改与审稿，审核差异后应用更改。" },
  { icon: icons.organization, title: "版本与协作", description: "保留修改历史，邀请共同作者一起编辑和讨论。" }
];

export function ProductLanding({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link variant="inherit" className="brand" href="/projects">
          <span className="brand__mark">F</span><span>FastWrite</span>
        </Link>
        <nav className={styles.navigation} aria-label="首页导航">
          <Link href="/diagrams">科研绘图</Link>
          <ThemeToggle />
          <Button variant="ghost" onClick={onSignIn}>登录</Button>
        </nav>
      </header>
      <main className={styles.main}>
        <section className={styles.introduction} aria-labelledby="landing-title">
          <p className={styles.category}>论文写作工作区</p>
          <h1 id="landing-title">论文写作，<br />从这里开始。</h1>
          <p className={styles.description}>将 LaTeX、参考论文和 AI 修改放在同一个工作区。</p>
          <div className={styles.start}>
            <Button variant="primary" icon={<Icon name={icons.arrowRight} />} onClick={onSignIn}>进入工作区</Button>
            <span>登录后导入项目，或新建论文。</span>
          </div>
          <div className={styles.imports}>
            <span><Icon name={icons.folderOpened} /> 本地 LaTeX 项目</span>
            <span><Icon name={icons.github} /> GitHub 仓库</span>
          </div>
        </section>
        <aside className={styles.tools} aria-labelledby="landing-tools-title">
          <header><span className={styles.indicator} aria-hidden="true" /><h2 id="landing-tools-title">写作工具</h2><span>同一个工作区</span></header>
          <List label="写作工具">
            {tools.map(tool => <ListRow key={tool.title}>
              <span className={styles.toolIcon}><Icon name={tool.icon} size={20} /></span>
              <div><h3>{tool.title}</h3><p>{tool.description}</p></div>
            </ListRow>)}
          </List>
          <p className={styles.reviewNote}><Icon name={icons.check} /> AI 修改经过审核后，才会写入文件。</p>
        </aside>
      </main>
      <footer className={styles.footer}><span>FastWrite</span><span>LaTeX · PDF · AI</span></footer>
    </div>
  );
}
