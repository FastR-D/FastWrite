import { useEffect, useState } from "react";
import { Button, Field, Icon, SegmentedControl, Tag, TextField, icons } from "../components/ui";
import styles from "./TypographyPreview.module.css";

const examples = [
  { id: "plex", name: "IBM Plex Sans + Noto Sans SC", description: "技术感更明确，作为当前默认。", sample: styles.plex },
  { id: "geist", name: "Geist + Noto Sans SC", description: "轮廓更简洁，适合偏现代的界面。", sample: styles.geist },
  { id: "system", name: "系统 UI 字体", description: "跟随设备，作为原生观感对照。", sample: styles.system }
] as const;
type FontPreview = typeof examples[number]["id"];

export function TypographyPreview() {
  const [preview, setPreview] = useState<FontPreview>("plex");
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.fontPreview;
    return () => {
      if (previous === undefined) delete root.dataset.fontPreview;
      else root.dataset.fontPreview = previous;
    };
  }, []);
  useEffect(() => { document.documentElement.dataset.fontPreview = preview; }, [preview]);

  return <section className={styles.section} aria-labelledby="typography-preview-title">
    <div className={styles.heading}>
      <div><h2 id="typography-preview-title">中英文字体试用</h2><p>界面正文使用 500 字重，标题保留层级；代码使用 JetBrains Mono 450。切换会预览到整个目录。</p></div>
      <SegmentedControl label="字体预览方案" value={preview} onChange={setPreview} options={[
        { value: "plex", label: "Plex" }, { value: "geist", label: "Geist" }, { value: "system", label: "系统字体" }
      ]} />
    </div>
    <div className={styles.grid}>
      {examples.map(example => <article key={example.id} className={`${styles.sample} ${example.sample ?? ""}`} aria-label={example.name}>
        <header><span>{example.id === "plex" ? "当前默认" : "对照方案"}</span><Tag tone={preview === example.id ? "ai" : "neutral"}>{preview === example.id ? "预览中" : "500 字重"}</Tag></header>
        <h3>{example.name}</h3>
        <p className={styles.description}>{example.description}</p>
        <p className={styles.chinese}>让论文写作更清晰，让修改更从容。</p>
        <p className={styles.english}>Write with clarity. Review every change.</p>
        <p className={styles.small}>修改要求 · 编译成功 · main.tex · 0123456789</p>
        <Field label="混合文字输入"><TextField aria-label={`${example.id} 字体示例`} defaultValue="研究方法 Research methods · 2026" /></Field>
        <div className={styles.actions}><Button size="small" variant="secondary" icon={<Icon name={icons.gitCompare} />}>查看修改</Button><Button size="small" variant={preview === example.id ? "primary" : "ghost"} aria-pressed={preview === example.id} onClick={() => setPreview(example.id)}>预览此方案</Button></div>
        <pre className={styles.code}><code>{"\\section{研究方法}\nconst observations = 17;\n// Il1 · O0 · 0123456789"}</code></pre>
      </article>)}
    </div>
  </section>;
}
