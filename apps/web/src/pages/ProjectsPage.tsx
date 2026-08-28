import { useCallback, useEffect, useState } from "react";
import { ArrowRight, BookOpenText, Clock3, FilePlus2, FolderGit2, Plus } from "lucide-react";
import type { PaperProject, PublicationTarget, PublicationVenueOption, WritingProfile } from "@fastwrite/shared";
import { WRITING_PROFILES } from "@fastwrite/shared";
import { api } from "../api/client";
import { ImportDialog } from "../components/import/ImportDialog";
import { Button } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";
import { PublicationTargetFields } from "../components/ui/PublicationTargetFields";
import { navigate, projectPath } from "../lib/navigation";
import { publicationTargetAbbreviation } from "../lib/labels";
import { ThemeToggle } from "../components/ui/ThemeToggle";

export function ProjectsPage() {
  const [projects, setProjects] = useState<PaperProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      setProjects(await api.projects.list(signal));
    } catch (loadError) {
      if ((loadError as DOMException).name !== "AbortError") setError(loadError instanceof Error ? loadError.message : "Could not load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjects(controller.signal);
    return () => controller.abort();
  }, [loadProjects]);

  const openProject = (project: PaperProject) => navigate(projectPath(project.id));

  return (
    <div className="projects-page">
      <header className="projects-topbar">
        <a className="brand" href="/projects" onClick={(event) => { event.preventDefault(); navigate("/projects"); }}>
          <span className="brand__mark">F</span>
          <span>FastWrite</span>
        </a>
        <div className="topbar-actions"><span className="skill-badge">Agentic Paper Writing</span><ThemeToggle /></div>
      </header>
      <main className="projects-main">
        <section className="projects-hero">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h1>Your papers, ready to write.</h1>
            <p>Import an existing LaTeX project or start a new paper in a focused writing workspace.</p>
          </div>
          <div className="projects-hero__actions">
            <Button variant="primary" icon={<Plus />} onClick={() => setImportOpen(true)}>Import paper</Button>
            <Button variant="secondary" icon={<FilePlus2 />} onClick={() => setNewOpen(true)}>New paper</Button>
          </div>
        </section>

        <section className="projects-section" aria-labelledby="recent-projects">
          <div className="section-heading">
            <div><h2 id="recent-projects">Recent projects</h2><p>Papers available in this FastWrite workspace.</p></div>
            <span>{projects.length} {projects.length === 1 ? "project" : "projects"}</span>
          </div>
          {error ? <div className="page-error" role="alert"><strong>Could not load projects</strong><span>{error}</span><Button size="small" onClick={() => void loadProjects()}>Try again</Button></div> : null}
          {loading ? <ProjectSkeletons /> : projects.length === 0 ? (
            <div className="projects-empty">
              <div className="projects-empty__art"><BookOpenText /></div>
              <h3>No papers yet</h3>
              <p>Bring in a local directory or GitHub repository to open the full writing workspace.</p>
              <Button variant="primary" icon={<FolderGit2 />} onClick={() => setImportOpen(true)}>Import your first paper</Button>
            </div>
          ) : (
            <div className="project-grid">
              {projects.map((project) => (
                <button key={project.id} className="project-card" onClick={() => openProject(project)}>
                  <div className="project-card__top">
                    <span className="project-card__icon"><BookOpenText /></span>
                    <ArrowRight className="project-card__arrow" />
                  </div>
                  <h3>{project.name}</h3>
                  <code>{project.mainDocument}</code>
                  <div className="project-card__meta">
                    <span><Clock3 /> {relativeTime(project.updatedAt)}</span>
                    <span>{publicationTargetAbbreviation(project.publicationTarget, project.skill.id)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={openProject} />
      <NewPaperDialog open={newOpen} onClose={() => setNewOpen(false)} onCreated={openProject} />
    </div>
  );
}

function NewPaperDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (project: PaperProject) => void }) {
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<WritingProfile>("network-information-security");
  const [publicationTarget, setPublicationTarget] = useState<PublicationTarget | undefined>();
  const [selectedVenue, setSelectedVenue] = useState<PublicationVenueOption | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    setLoading(true);
    setError("");
    try {
      onCreated(await api.projects.create({ name: name.trim(), mainDocument: "main.tex", venue: profile, ...(publicationTarget ? { publicationTarget } : {}), ...(selectedVenue?.template ? { initializeFromTemplate: true } : {}) }));
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create project");
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog open={open} title="Create a new paper" description={selectedVenue?.template ? "Start from the selected venue's complete LaTeX template." : "Start with a minimal, compilable LaTeX document."} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={loading} disabled={!name.trim()} onClick={() => void create()}>Create paper</Button></>}>
      <div className="form-stack">
        <label className="field"><span>Project name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="My security paper" autoFocus /></label>
        <label className="field"><span>Research domain</span><select value={profile} onChange={(event) => { setProfile(event.target.value as WritingProfile); setPublicationTarget(undefined); setSelectedVenue(undefined); }}>{WRITING_PROFILES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><small>The research domain and selected venue jointly guide all writing workflows.</small></label>
        <PublicationTargetFields profile={profile} value={publicationTarget} onChange={setPublicationTarget} onSelectedVenueChange={setSelectedVenue} />
        {selectedVenue?.template ? <div className="field field--template-info">
          <span>{selectedVenue.template.label}.</span>
          <small><a href={selectedVenue.template.sourceUrl} target="_blank" rel="noreferrer">Inspect source</a>.</small>
          <small>{selectedVenue.template.trust === "official" ? "Fetched from the venue's official source." : selectedVenue.template.trust === "publisher" ? "Publisher-family starting point; confirm the venue-specific options." : "Current community-maintained source; compare it with the official author guide before submission."}</small>
        </div> : null}
        {error ? <div className="form-error" role="alert">{error}</div> : null}
      </div>
    </Dialog>
  );
}

function ProjectSkeletons() {
  return <div className="project-grid" aria-label="Loading projects">{[0, 1, 2].map((item) => <div className="project-card project-card--skeleton" key={item}><i /><i /><i /></div>)}</div>;
}

function relativeTime(value: string): string {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}
