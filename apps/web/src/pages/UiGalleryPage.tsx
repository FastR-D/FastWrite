import { useState } from "react";
import { AlertTriangle, Check, ChevronRight, FileText, Folder, Info, LoaderCircle, Plus, Search, Trash2 } from "lucide-react";
import { Button, IconButton } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";

const TOKENS = [
  ["Blue 600", "#1769aa"], ["Blue 50", "#edf6ff"], ["Slate 900", "#182235"], ["Slate 600", "#59677a"],
  ["Surface", "#ffffff"], ["Canvas", "#e4e6e9"], ["Success", "#18864b"], ["Danger", "#c83e3e"]
] as const;

export function UiGalleryPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tab, setTab] = useState("Files");
  return <main className="ui-gallery">
    <header className="ui-gallery__hero"><div><span className="brand__mark">F</span><strong>FastWrite UI</strong></div><p>Overleaf-density components · FastWrite blue</p><a href="/projects">Back to projects</a></header>
    <section className="ui-gallery__intro"><p>DESIGN SYSTEM</p><h1>Compact, quiet, precise.</h1><span>Production components and states used by the paper workspace.</span></section>

    <GallerySection title="Color tokens" description="Semantic surfaces keep the editor, PDF canvas and Agent states visually distinct.">
      <div className="token-grid">{TOKENS.map(([name, color]) => <div className="token-swatch" key={name}><span style={{ background: color }} /><strong>{name}</strong><code>{color}</code></div>)}</div>
    </GallerySection>

    <GallerySection title="Buttons" description="One primary action per region; secondary and ghost actions remain visually quiet.">
      <div className="component-row"><Button variant="primary" icon={<Plus />}>Primary</Button><Button variant="secondary">Secondary</Button><Button variant="ghost">Ghost</Button><Button variant="danger" icon={<Trash2 />}>Destructive</Button><Button variant="primary" loading>Loading</Button><Button disabled>Disabled</Button></div>
      <div className="component-row"><IconButton label="Search" icon={<Search />} /><IconButton label="Delete" variant="danger" icon={<Trash2 />} /><span className="gallery-tooltip" data-tooltip="Tooltip explains compact icon actions"><IconButton label="More information" icon={<Info />} /></span></div>
    </GallerySection>

    <GallerySection title="Inputs and validation" description="Inputs use the same focus ring, density and error language across import and Agent flows.">
      <div className="gallery-form"><label className="field"><span>Project name</span><input defaultValue="A secure systems paper" /></label><label className="field"><span>Research domain</span><select defaultValue="network-information-security"><option value="network-information-security">网络与信息安全</option><option value="artificial-intelligence">人工智能</option></select></label><label className="field field--error"><span>Workspace path</span><input defaultValue="../escape.tex" aria-invalid="true" /><small>Use a path inside the managed Workspace.</small></label><label className="field"><span>Disabled</span><input disabled defaultValue="main.tex" /></label></div>
    </GallerySection>

    <GallerySection title="Tabs, progress and feedback" description="Status is always expressed with text or an icon, never color alone.">
      <div className="gallery-tabs" role="tablist" aria-label="Gallery tabs">{["Files", "Outline", "Issues"].map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? "is-active" : ""} key={item} onClick={() => setTab(item)}>{item}</button>)}</div>
      <div className="gallery-progress"><div><strong>Loading TeX bundles</strong><span>68% · 34.4 MB / 50.6 MB · core.data.gz</span></div><div className="progress-track"><span style={{ width: "68%" }} /></div></div>
      <div className="gallery-feedback"><span className="gallery-toast gallery-toast--success"><Check /> Compiled successfully</span><span className="gallery-toast gallery-toast--error"><AlertTriangle /> File version changed</span><span className="gallery-toast"><LoaderCircle className="spin" /> Applying venue rules</span></div>
    </GallerySection>

    <GallerySection title="Tree, empty state and split handle" description="Navigation remains readable at the workspace's dense operating size.">
      <div className="gallery-structures"><div className="gallery-tree" role="tree"><div role="treeitem" aria-expanded="true"><Folder /> sections <ChevronRight /></div><div role="treeitem" className="is-child is-selected"><FileText /> introduction.tex</div><div role="treeitem" className="is-child"><FileText /> evaluation.tex</div><div role="treeitem"><FileText /> main.tex</div></div><div className="gallery-split"><div>Editor</div><span role="separator" aria-label="Example split pane" tabIndex={0} /><div>PDF</div></div><div className="gallery-empty"><FileText /><strong>No review issues</strong><span>Run Review when the current version is ready.</span><Button size="small" variant="secondary">Start review</Button></div></div>
    </GallerySection>

    <GallerySection title="Dialog" description="Dialogs trap focus, close with Escape and keep destructive actions explicit.">
      <Button variant="primary" onClick={() => setDialogOpen(true)}>Open example dialog</Button>
    </GallerySection>
    <Dialog open={dialogOpen} title="Move file to trash?" description="sections/obsolete.tex" onClose={() => setDialogOpen(false)} footer={<><Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button><Button variant="danger" icon={<Trash2 />} onClick={() => setDialogOpen(false)}>Move to trash</Button></>}><p className="dialog-copy">The file can be recovered from managed Workspace storage.</p></Dialog>
  </main>;
}

function GallerySection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="ui-gallery__section"><header><div><h2>{title}</h2><p>{description}</p></div></header><div className="ui-gallery__canvas">{children}</div></section>;
}
