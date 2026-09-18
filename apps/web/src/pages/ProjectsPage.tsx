import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  Bell,
  BookOpenText,
  CheckCircle2,
  CircleUserRound,
  Clock3,
  FilePlus2,
  FolderGit2,
  LogOut,
  Plus,
  Trash2,
  UsersRound,
} from "lucide-react";
import type {
  PaperProject,
  PublicationTarget,
  PublicationVenueOption,
  WritingProfile,
} from "@fastwrite/shared";
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
  const invitationToken = new URLSearchParams(window.location.search).get(
    "invite",
  );
  const [projects, setProjects] = useState<PaperProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [account, setAccount] = useState<{
    displayName: string;
    emailNormalized: string;
  } | null>(null);
  const [invitationState, setInvitationState] = useState<
    "idle" | "accepting" | "accepted" | "error"
  >(invitationToken ? "idle" : "idle");
  const [invitationError, setInvitationError] = useState("");

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    if (!localStorage.getItem("fastwrite.session-token")) {
      setProjects([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setProjects(await api.projects.list(signal));
    } catch (loadError) {
      if ((loadError as DOMException).name !== "AbortError")
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load projects",
        );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjects(controller.signal);
    return () => controller.abort();
  }, [loadProjects]);
  useEffect(() => {
    if (!localStorage.getItem("fastwrite.session-token")) return;
    api.auth
      .me()
      .then(setAccount)
      .catch(() => localStorage.removeItem("fastwrite.session-token"));
  }, []);

  const acceptInvitation = useCallback(async () => {
    if (
      !invitationToken ||
      !account ||
      invitationState === "accepting" ||
      invitationState === "accepted"
    )
      return;
    setInvitationState("accepting");
    setInvitationError("");
    try {
      await api.invitations.accept(invitationToken);
      setInvitationState("accepted");
      window.history.replaceState({}, "", "/projects");
      await loadProjects();
    } catch (failure) {
      setInvitationState("error");
      setInvitationError(
        failure instanceof Error
          ? failure.message
          : "Could not accept invitation",
      );
    }
  }, [account, invitationState, invitationToken, loadProjects]);

  useEffect(() => {
    if (account && invitationToken) void acceptInvitation();
  }, [acceptInvitation, account, invitationToken]);

  if (!account) {
    return (
      <>
        <ProductLanding onSignIn={() => setAccountOpen(true)} />
        <AccountDialog
          open={accountOpen}
          onClose={() => setAccountOpen(false)}
          onAuthenticated={(next) => {
            setAccount(next);
            setAccountOpen(false);
            void loadProjects();
          }}
        />
      </>
    );
  }

  const openProject = (project: PaperProject) =>
    navigate(projectPath(project.id));
  const deleteProject = async (project: PaperProject) => {
    if (!window.confirm(`Move project "${project.name}" to trash?`)) return;
    setDeleting(project.id);
    setError("");
    try {
      await api.projects.delete(project.id);
      await loadProjects();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not delete project",
      );
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="projects-page">
      <header className="projects-topbar">
        <a
          className="brand"
          href="/projects"
          onClick={(event) => {
            event.preventDefault();
            navigate("/projects");
          }}
        >
          <span className="brand__mark">F</span>
          <span>FastWrite</span>
        </a>
        <div className="topbar-actions">
          <span className="skill-badge">Agentic Paper Writing</span>
          <Button
            size="small"
            variant="ghost"
            icon={<UsersRound />}
            onClick={() => setTeamsOpen(true)}
          >
            Teams
          </Button>
          {account ? (
            <Button
              size="small"
              variant="ghost"
              icon={<Bell />}
              onClick={() => setNotificationsOpen(true)}
            >
              Notifications
            </Button>
          ) : null}
          <Button
            size="small"
            variant="ghost"
            icon={account ? <LogOut /> : <CircleUserRound />}
            onClick={() =>
              account
                ? void api.auth.logout().finally(() => {
                    localStorage.removeItem("fastwrite.session-token");
                    setAccount(null);
                    void loadProjects();
                  })
                : setAccountOpen(true)
            }
          >
            {account ? account.displayName : "Sign in"}
          </Button>
          <ThemeToggle />
        </div>
      </header>
      <main className="projects-main">
        <section className="projects-hero">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h1>Your papers, ready to write.</h1>
            <p>
              Import an existing LaTeX project or start a new paper in a focused
              writing workspace.
            </p>
          </div>
          <div className="projects-hero__actions">
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() => setImportOpen(true)}
            >
              Import paper
            </Button>
            <Button
              variant="secondary"
              icon={<FilePlus2 />}
              onClick={() => setNewOpen(true)}
            >
              New paper
            </Button>
          </div>
        </section>

        <section className="projects-section" aria-labelledby="recent-projects">
          {invitationToken ? (
            <div
              className={
                invitationState === "error" ? "page-error" : "form-notice"
              }
              role={invitationState === "error" ? "alert" : "status"}
            >
              {!account ? (
                <>
                  <span>
                    Sign in with the invited email address to join this project.
                  </span>
                  <Button size="small" onClick={() => setAccountOpen(true)}>
                    Sign in
                  </Button>
                </>
              ) : invitationState === "accepting" ? (
                "Accepting invitation..."
              ) : invitationState === "accepted" ? (
                "Invitation accepted. The project is now available in your workspace."
              ) : (
                invitationError || "Preparing invitation..."
              )}
            </div>
          ) : null}
          <div className="section-heading">
            <div>
              <h2 id="recent-projects">Recent projects</h2>
              <p>Papers available in this FastWrite workspace.</p>
            </div>
            <span>
              {projects.length} {projects.length === 1 ? "project" : "projects"}
            </span>
          </div>
          {error ? (
            <div className="page-error" role="alert">
              <strong>Could not load projects</strong>
              <span>{error}</span>
              <Button size="small" onClick={() => void loadProjects()}>
                Try again
              </Button>
            </div>
          ) : null}
          {loading ? (
            <ProjectSkeletons />
          ) : projects.length === 0 ? (
            <div className="projects-empty">
              <div className="projects-empty__art">
                <BookOpenText />
              </div>
              <h3>No papers yet</h3>
              <p>
                Bring in a local directory or GitHub repository to open the full
                writing workspace.
              </p>
              <Button
                variant="primary"
                icon={<FolderGit2 />}
                onClick={() => setImportOpen(true)}
              >
                Import your first paper
              </Button>
            </div>
          ) : (
            <div className="project-grid">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="project-card"
                  role="group"
                  onClick={() => openProject(project)}
                >
                  <div className="project-card__top">
                    <span className="project-card__icon">
                      <BookOpenText />
                    </span>
                    <span className="project-card__actions">
                      <ArrowRight className="project-card__arrow" />
                      <button
                        type="button"
                        className="project-card__delete"
                        aria-label={`Delete ${project.name}`}
                        title="Move project to trash"
                        disabled={deleting === project.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteProject(project);
                        }}
                      >
                        <Trash2 />
                      </button>
                    </span>
                  </div>
                  <h3>{project.name}</h3>
                  <code>{project.mainDocument}</code>
                  <div className="project-card__meta">
                    <span>
                      <Clock3 /> {relativeTime(project.updatedAt)}
                    </span>
                    <span>
                      {publicationTargetAbbreviation(
                        project.publicationTarget,
                        project.skill.id,
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={openProject}
      />
      <NewPaperDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={openProject}
      />
      <AccountDialog
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        onAuthenticated={(next) => {
          setAccount(next);
          setAccountOpen(false);
          void loadProjects();
        }}
      />
      <TeamsDialog open={teamsOpen} onClose={() => setTeamsOpen(false)} />
      <NotificationsDialog
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />
    </div>
  );
}

function ProductLanding({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="product-landing">
      <header className="product-landing__nav">
        <a className="brand" href="/projects"><span className="brand__mark">F</span><span>FastWrite</span></a>
        <div className="product-landing__nav-actions"><a href="#workflow">How it works</a><a href="#research">For research teams</a><Button size="small" variant="secondary" icon={<CircleUserRound />} onClick={onSignIn}>Sign in</Button><ThemeToggle /></div>
      </header>
      <main>
        <section className="product-landing__hero">
          <div className="product-landing__hero-copy"><p className="eyebrow">THE RESEARCH WRITING WORKSPACE</p><h1>Write papers together.<br /><em>Keep every claim accountable.</em></h1><p className="product-landing__lede">FastWrite brings LaTeX, evidence, review, and careful AI assistance into one workspace built for serious academic collaboration.</p><div className="product-landing__actions"><Button variant="primary" icon={<ArrowRight />} onClick={onSignIn}>Open your workspace</Button><a href="#workflow" className="product-landing__text-link">See the workflow <ArrowRight size={16} /></a></div></div>
          <div className="product-landing__hero-art" aria-label="A focused academic writing workspace"><div className="landing-window"><div className="landing-window__bar"><span /><span /><span /></div><div className="landing-window__body"><div className="landing-sidebar"><b>PROJECT</b><i>▾ Draft paper</i><i>◦ Introduction.tex</i><i>◦ Methods.tex</i><i>◦ references.bib</i></div><div className="landing-editor"><small>INTRODUCTION.TEX</small><p><span>01</span> <strong>\\section&#123;Introduction&#125;</strong></p><p><span>02</span> Research is a shared process.</p><p><span>03</span> <mark>Evidence turns ideas into knowledge.</mark></p><p><span>04</span> Collaborate with confidence.</p><div className="landing-cursor" /></div><div className="landing-pdf"><div className="pdf-page-mock"><b>FastWrite</b><hr /><strong>Evidence-first writing</strong><p>Build, review, and refine your research with your team.</p><hr /><small>1  |  DRAFT</small></div></div></div></div></div>
        </section>
        <section id="workflow" className="product-landing__section"><p className="eyebrow">A BETTER RESEARCH LOOP</p><h2>From first outline to final PDF, the record stays clear.</h2><div className="product-landing__grid"><LandingFeature icon={<FolderGit2 />} title="One source of truth" text="Edit LaTeX together with versioned files, checkpoints, and a PDF that always shows what was compiled." /><LandingFeature icon={<UsersRound />} title="Collaboration with context" text="Invite coauthors, discuss anchored passages, and keep decisions attached to the text they change." /><LandingFeature icon={<BookOpenText />} title="AI with guardrails" text="Use evidence-aware skills to propose changes. Review every diff before it reaches the manuscript." /></div></section>
        <section id="research" className="product-landing__proof"><div><p className="eyebrow">BUILT FOR ACADEMIC TEAMS</p><h2>Move quickly without losing the trail.</h2><p>FastWrite keeps authorship, sources, review findings, and compile history connected so your team can focus on the argument.</p></div><div className="product-landing__proof-list"><span><CheckCircle2 /> Evidence-linked revisions</span><span><CheckCircle2 /> Team roles and path-level access</span><span><CheckCircle2 /> OIDC and campus CAS ready</span></div></section>
      </main>
      <footer className="product-landing__footer"><span>FastWrite</span><span>Research writing, with a record you can trust.</span><button onClick={onSignIn}>Sign in to begin <ArrowRight size={15} /></button></footer>
    </div>
  );
}

function LandingFeature({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <article className="product-landing__feature"><span className="product-landing__feature-icon">{icon}</span><h3>{title}</h3><p>{text}</p></article>;
}

function AccountDialog({
  open,
  onClose,
  onAuthenticated,
}: {
  open: boolean;
  onClose: () => void;
  onAuthenticated: (user: {
    displayName: string;
    emailNormalized: string;
  }) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<{ oidc: boolean; cas: boolean }>({ oidc: false, cas: false });
  useEffect(() => { if (open) void api.auth.providers().then((value) => setProviders(value)).catch(() => undefined); }, [open]);
  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      const result =
        mode === "login"
          ? await api.auth.login({ email, password })
          : await api.auth.register({
              email,
              password,
              ...(name.trim() ? { displayName: name.trim() } : {}),
            });
      localStorage.setItem("fastwrite.session-token", result.token);
      onAuthenticated(result.user);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not authenticate",
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog
      open={open}
      title={mode === "login" ? "Sign in" : "Create account"}
      description="Use your FastWrite account for team projects and review comments."
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
          >
            {mode === "login" ? "Create account" : "Use existing account"}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="account-auth-form"
            loading={loading}
            disabled={!email.trim() || !password}
          >
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </>
      }
    >
      <form id="account-auth-form" className="form-stack" onSubmit={(event) => { event.preventDefault(); if (!loading && email.trim() && password) void submit(); }}>
        {mode === "login" && (providers.oidc || providers.cas) ? <div className="form-stack">
          {providers.oidc ? <Button type="button" variant="secondary" onClick={() => { window.location.assign(`/api/auth/oidc/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`); }}>Continue with organization sign-in</Button> : null}
          {providers.cas ? <Button type="button" variant="secondary" onClick={() => { window.location.assign("/api/auth/cas/login"); }}>Continue with campus CAS</Button> : null}
        </div> : null}
        {mode === "register" ? (
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              name="name"
              autoComplete="name"
              autoFocus
            />
          </label>
        ) : null}
        <label className="field">
          <span>Email</span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            name="email"
            autoComplete="username"
            autoFocus={mode === "login"}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            name="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={12}
          />
        </label>
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

function TeamsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [teams, setTeams] = useState<
    Array<{ id: string; name: string; slug: string; personalUserId?: string }>
  >([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [inviteMessage, setInviteMessage] = useState("");
  const [policy, setPolicy] = useState<{
    personalHarness: boolean;
    allowedProviders?: Array<"codex" | "claude" | "openai-compatible">;
    maxConcurrentRuns?: number;
    dailyBudgetUsd?: number;
  }>({ personalHarness: false });
  const [invitationLink, setInvitationLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<
    Array<{
      userId: string;
      role: "owner" | "admin" | "member";
      user: { displayName: string; emailNormalized: string };
    }>
  >([]);
  const [canManageMembers, setCanManageMembers] = useState(false);
  const [canManageInvitations, setCanManageInvitations] = useState(false);
  const [invitations, setInvitations] = useState<
    Array<{
      id: string;
      emailNormalized: string;
      role: string;
      expiresAt: string;
      message?: string;
      acceptedAt?: string;
      revokedAt?: string;
    }>
  >([]);
  const [groupBindings, setGroupBindings] = useState<Array<{ id: string; idpGroup: string; role: "admin" | "member" }>>([]);
  const [groupValue, setGroupValue] = useState("");
  const [groupRole, setGroupRole] = useState<"admin" | "member">("member");
  const [groupPreview, setGroupPreview] = useState<Array<{ id: string; idpGroup: string; role: "admin" | "member" }>>([]);
  const selected = teams.find((team) => team.id === selectedId);
  const load = useCallback(async () => {
    try {
      const items = await api.teams.list();
      setTeams(items);
      setSelectedId(
        (current) =>
          current || items.find((team) => !team.personalUserId)?.id || "",
      );
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not load teams",
      );
    }
  }, []);
  useEffect(() => {
    if (open) {
      setInvitationLink("");
      void load();
    }
  }, [load, open]);
  useEffect(() => {
    if (!selected || selected.personalUserId) return;
    api.teams
      .policy(selected.id)
      .then(setPolicy)
      .catch((failure) =>
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not load team policy",
        ),
      );
  }, [selected?.id, selected?.personalUserId]);
  const loadGovernance = useCallback(async () => {
    if (!selected || selected.personalUserId) {
      setMembers([]);
      setInvitations([]);
      setGroupBindings([]);
      return;
    }
    try {
      const [roster, pending, bindings] = await Promise.all([
        api.teams.members(selected.id),
        api.teams.invitations(selected.id),
        api.teams.groupBindings(selected.id),
      ]);
      setMembers(roster.members);
      setCanManageMembers(roster.canManage);
      setCanManageInvitations(roster.canManageInvitations);
      setInvitations(pending);
      setGroupBindings(bindings);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not load team governance",
      );
    }
  }, [selected?.id, selected?.personalUserId]);
  useEffect(() => {
    void loadGovernance();
  }, [loadGovernance]);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await api.teams.create(name.trim());
      setName("");
      await load();
      setSelectedId(created.id);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not create team",
      );
    } finally {
      setBusy(false);
    }
  };
  const savePolicy = async () => {
    if (!selected || selected.personalUserId) return;
    setBusy(true);
    try {
      await api.teams.updatePolicy(selected.id, policy);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save team policy",
      );
    } finally {
      setBusy(false);
    }
  };
  const invite = async () => {
    if (!selected || selected.personalUserId || !email.trim()) return;
    setBusy(true);
    try {
      const result = await api.teams.invite(selected.id, {
        email: email.trim(),
        role,
        ...(inviteExpiresAt
          ? { expiresAt: new Date(inviteExpiresAt).toISOString() }
          : {}),
        ...(inviteMessage.trim() ? { message: inviteMessage.trim() } : {}),
      });
      setInvitationLink(
        `${window.location.origin}/projects?invite=${encodeURIComponent(result.token)}`,
      );
      setEmail("");
      setInviteExpiresAt("");
      setInviteMessage("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not invite team member",
      );
    } finally {
      setBusy(false);
    }
  };
  const changeMemberRole = async (
    userId: string,
    nextRole: "admin" | "member",
  ) => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.teams.updateMember(selected.id, userId, nextRole);
      await loadGovernance();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not update team member",
      );
    } finally {
      setBusy(false);
    }
  };
  const removeMember = async (userId: string) => {
    if (!selected || !window.confirm("Remove this member from the team?"))
      return;
    setBusy(true);
    try {
      await api.teams.removeMember(selected.id, userId);
      await loadGovernance();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not remove team member",
      );
    } finally {
      setBusy(false);
    }
  };
  const manageInvitation = async (id: string, action: "resend" | "revoke") => {
    if (!selected) return;
    setBusy(true);
    try {
      if (action === "resend") {
        const result = await api.teams.resendInvitation(id);
        setInvitationLink(
          `${window.location.origin}/projects?invite=${encodeURIComponent(result.token)}`,
        );
      } else await api.teams.revokeInvitation(id);
      await loadGovernance();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not update invitation",
      );
    } finally {
      setBusy(false);
    }
  };
  const saveGroupBinding = async () => {
    if (!selected || !groupValue.trim()) return;
    setBusy(true);
    try { await api.teams.saveGroupBinding(selected.id, "new", { idpGroup: groupValue.trim(), role: groupRole }); setGroupValue(""); await loadGovernance(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save IdP group binding"); }
    finally { setBusy(false); }
  };
  const previewGroupBinding = async () => {
    if (!selected || !groupValue.trim()) return;
    setBusy(true);
    try { setGroupPreview(await api.teams.previewGroupBindings(selected.id, [groupValue.trim()])); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not preview IdP group binding"); }
    finally { setBusy(false); }
  };
  const removeGroupBinding = async (id: string) => {
    if (!selected) return;
    setBusy(true);
    try { await api.teams.deleteGroupBinding(selected.id, id); await loadGovernance(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not remove IdP group binding"); }
    finally { setBusy(false); }
  };
  const toggleProvider = (
    provider: "codex" | "claude" | "openai-compatible",
    enabled: boolean,
  ) =>
    setPolicy((current) => {
      const next = { ...current };
      const providers = new Set(current.allowedProviders ?? []);
      if (enabled) providers.add(provider);
      else providers.delete(provider);
      if (providers.size) next.allowedProviders = [...providers];
      else delete next.allowedProviders;
      return next;
    });
  return (
    <Dialog
      open={open}
      title="Teams"
      description="Create a research team, set its default Harness policy, and invite members."
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="form-stack">
        <label className="field">
          <span>Team</span>
          <select
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            <option value="">Choose a team</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.personalUserId
                  ? `${team.name} (personal workspace)`
                  : team.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>New team</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Applied Cryptography Lab"
          />
        </label>
        <Button
          size="small"
          variant="secondary"
          disabled={busy || !name.trim()}
          onClick={() => void create()}
        >
          Create team
        </Button>
        {selected && !selected.personalUserId ? (
          <>
            <label className="field">
              <span>
                <input
                  type="checkbox"
                  checked={policy.personalHarness}
                  onChange={(event) =>
                    setPolicy((current) => ({
                      ...current,
                      personalHarness: event.target.checked,
                    }))
                  }
                />{" "}
                Allow personal Harness profiles
              </span>
            </label>
            <fieldset className="field">
              <legend>Allowed Harness providers</legend>
              {(["codex", "claude", "openai-compatible"] as const).map(
                (provider) => (
                  <label key={provider}>
                    <input
                      type="checkbox"
                      checked={
                        policy.allowedProviders?.includes(provider) ?? false
                      }
                      onChange={(event) =>
                        toggleProvider(provider, event.target.checked)
                      }
                    />{" "}
                    {provider}
                  </label>
                ),
              )}
            </fieldset>
            <label className="field">
              <span>Maximum concurrent runs</span>
              <input
                type="number"
                min="1"
                max="100"
                value={policy.maxConcurrentRuns ?? ""}
                onChange={(event) =>
                  setPolicy((current) => {
                    const next = { ...current };
                    if (event.target.value)
                      next.maxConcurrentRuns = Number(event.target.value);
                    else delete next.maxConcurrentRuns;
                    return next;
                  })
                }
              />
            </label>
            <label className="field">
              <span>Daily budget (USD)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={policy.dailyBudgetUsd ?? ""}
                onChange={(event) =>
                  setPolicy((current) => {
                    const next = { ...current };
                    if (event.target.value)
                      next.maxConcurrentRuns = Number(event.target.value);
                    else delete next.maxConcurrentRuns;
                    return next;
                  })
                }
              />
            </label>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => void savePolicy()}
            >
              Save Harness policy
            </Button>
            {canManageMembers ? <fieldset className="field">
              <legend>IdP group bindings</legend>
              <label><span>Issuer-qualified group</span><input value={groupValue} onChange={(event) => { setGroupValue(event.target.value); setGroupPreview([]); }} placeholder="https://idp.example:lab-members" /></label>
              <label><span>Mapped role</span><select value={groupRole} onChange={(event) => setGroupRole(event.target.value as "admin" | "member")}><option value="member">Member</option><option value="admin">Admin</option></select></label>
              <div className="settings-agent__actions"><Button size="small" variant="secondary" disabled={busy || !groupValue.trim()} onClick={() => void previewGroupBinding()}>Preview</Button><Button size="small" variant="secondary" disabled={busy || !groupValue.trim()} onClick={() => void saveGroupBinding()}>Add binding</Button></div>
              {groupPreview.length ? <small>Matches: {groupPreview.map((binding) => `${binding.idpGroup} (${binding.role})`).join(", ")}</small> : null}
              {groupBindings.map((binding) => <div className="team-governance-row" key={binding.id}><span>{binding.idpGroup} <small>{binding.role}</small></span><Button size="small" variant="ghost" disabled={busy} onClick={() => void removeGroupBinding(binding.id)}>Remove</Button></div>)}
            </fieldset> : null}
            <label className="field">
              <span>Invite team member</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="researcher@university.edu"
              />
            </label>
            <label className="field">
              <span>Team role</span>
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as typeof role)}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label className="field">
              <span>Expires at (optional)</span>
              <input type="datetime-local" value={inviteExpiresAt} onChange={(event) => setInviteExpiresAt(event.target.value)} />
            </label>
            <label className="field">
              <span>Message (optional)</span>
              <textarea rows={3} maxLength={2000} value={inviteMessage} onChange={(event) => setInviteMessage(event.target.value)} />
            </label>
            <Button
              size="small"
              variant="secondary"
              disabled={busy || !email.trim()}
              onClick={() => void invite()}
            >
              Create invitation
            </Button>
            {invitationLink ? (
              <label className="field">
                <span>Invitation link (shown once)</span>
                <input
                  readOnly
                  value={invitationLink}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            ) : null}
            <fieldset className="field">
              <legend>Members</legend>
              {members.map((member) => (
                <div className="team-governance-row" key={member.userId}>
                  <span>
                    {member.user.displayName}{" "}
                    <small>{member.user.emailNormalized}</small>
                  </span>
                  {member.role === "owner" ? (
                    <strong>Owner</strong>
                  ) : canManageMembers ? (
                    <>
                      <select
                        value={member.role}
                        disabled={busy}
                        onChange={(event) =>
                          void changeMemberRole(
                            member.userId,
                            event.target.value as "admin" | "member",
                          )
                        }
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void removeMember(member.userId)}
                      >
                        Remove
                      </Button>
                    </>
                  ) : (
                    <strong>{member.role}</strong>
                  )}
                </div>
              ))}
              {!members.length ? <small>No members found.</small> : null}
            </fieldset>
            <fieldset className="field">
              <legend>Invitations</legend>
              {invitations.map((invitation) => (
                <div className="team-governance-row" key={invitation.id}>
                  <span>
                    {invitation.emailNormalized}{" "}
                    <small>
                      {invitation.role} ·{" "}
                      {invitation.acceptedAt
                        ? "accepted"
                        : invitation.revokedAt
                          ? "revoked"
                          : "pending"}
                    </small>
                    {invitation.message ? <small>{invitation.message}</small> : null}
                  </span>
                  {canManageInvitations &&
                  !invitation.acceptedAt &&
                  !invitation.revokedAt ? (
                    <>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void manageInvitation(invitation.id, "resend")
                        }
                      >
                        Resend
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void manageInvitation(invitation.id, "revoke")
                        }
                      >
                        Revoke
                      </Button>
                    </>
                  ) : null}
                </div>
              ))}
              {!invitations.length ? (
                <small>No invitations found.</small>
              ) : null}
            </fieldset>
          </>
        ) : selected ? (
          <p className="dialog-copy">
            Personal workspaces do not have a shared Harness policy or team
            invitations.
          </p>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function NotificationsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [notifications, setNotifications] = useState<
    Array<{
      id: string;
      title: string;
      body?: string;
      projectId?: string;
      readAt?: string;
      createdAt: string;
    }>
  >([]);
  const [preferences, setPreferences] = useState<
    Array<{
      type: "access_request" | "access_request_decision" | "mention";
      inApp: boolean;
      email: boolean;
    }>
  >([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [loadedNotifications, loadedPreferences] = await Promise.all([
        api.notifications.list(),
        api.notifications.preferences(),
      ]);
      setNotifications(loadedNotifications);
      setPreferences(loadedPreferences);
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not load notifications",
      );
    }
  }, []);
  useEffect(() => {
    if (open) void load();
  }, [load, open]);
  return (
    <Dialog
      open={open}
      title="Notifications"
      description="Project access and collaboration updates."
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="history-dialog">
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        {notifications.map((notification) => (
          <p className="dialog-copy" key={notification.id}>
            <strong>{notification.title}</strong>
            {notification.body ? ` ${notification.body}` : ""} ·{" "}
            {new Date(notification.createdAt).toLocaleString()}{" "}
            {!notification.readAt ? (
              <Button
                size="small"
                variant="ghost"
                onClick={async () => {
                  await api.notifications.markRead(notification.id);
                  await load();
                }}
              >
                Mark read
              </Button>
            ) : null}
          </p>
        ))}
        <div className="notification-preferences" aria-label="Notification preferences">
          <strong>Delivery preferences</strong>
          {preferences.map((preference) => (
            <div className="notification-preference-row" key={preference.type}>
              <span>{notificationPreferenceLabel(preference.type)}</span>
              <label><input type="checkbox" checked={preference.inApp} onChange={async (event) => { await api.notifications.updatePreference(preference.type, { inApp: event.target.checked }); await load(); }} /> In-app</label>
              <label><input type="checkbox" checked={preference.email} onChange={async (event) => { await api.notifications.updatePreference(preference.type, { email: event.target.checked }); await load(); }} /> Email</label>
            </div>
          ))}
        </div>
        {!notifications.length && !error ? (
          <p className="sidebar-empty">No notifications.</p>
        ) : null}
      </div>
    </Dialog>
  );
}

function notificationPreferenceLabel(type: "access_request" | "access_request_decision" | "mention") {
  if (type === "access_request") return "Access requests";
  if (type === "access_request_decision") return "Access decisions";
  return "Comment mentions";
}

function NewPaperDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: PaperProject) => void;
}) {
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<WritingProfile>(
    "network-information-security",
  );
  const [publicationTarget, setPublicationTarget] = useState<
    PublicationTarget | undefined
  >();
  const [selectedVenue, setSelectedVenue] = useState<
    PublicationVenueOption | undefined
  >();
  const [teams, setTeams] = useState<
    Array<{ id: string; name: string; personalUserId?: string }>
  >([]);
  const [teamId, setTeamId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    api.teams
      .list()
      .then((items) => {
        setTeams(items);
        setTeamId(
          (current) =>
            current || items.find((team) => team.personalUserId)?.id || "",
        );
      })
      .catch(() => {
        setTeams([]);
        setTeamId("");
      });
  }, [open]);
  const create = async () => {
    setLoading(true);
    setError("");
    try {
      const selectedTeam = teams.find((team) => team.id === teamId);
      onCreated(
        await api.projects.create({
          name: name.trim(),
          mainDocument: "main.tex",
          venue: profile,
          ...(publicationTarget ? { publicationTarget } : {}),
          ...(selectedVenue?.template ? { initializeFromTemplate: true } : {}),
          ...(selectedTeam && !selectedTeam.personalUserId
            ? { teamId: selectedTeam.id }
            : {}),
        }),
      );
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Could not create project",
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="Create a new paper"
      description={
        selectedVenue?.template
          ? "Start from the selected venue's complete LaTeX template."
          : "Start with a minimal, compilable LaTeX document."
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={loading}
            disabled={!name.trim()}
            onClick={() => void create()}
          >
            Create paper
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <label className="field">
          <span>Project name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My security paper"
            autoFocus
          />
        </label>
        {teams.length ? (
          <label className="field">
            <span>Workspace</span>
            <select
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.personalUserId ? `${team.name} (personal)` : team.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>Research domain</span>
          <select
            value={profile}
            onChange={(event) => {
              setProfile(event.target.value as WritingProfile);
              setPublicationTarget(undefined);
              setSelectedVenue(undefined);
            }}
          >
            {WRITING_PROFILES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <small>
            The research domain and selected venue jointly guide all writing
            workflows.
          </small>
        </label>
        <PublicationTargetFields
          profile={profile}
          value={publicationTarget}
          onChange={setPublicationTarget}
          onSelectedVenueChange={setSelectedVenue}
        />
        {selectedVenue?.template ? (
          <div className="field field--template-info">
            <span>{selectedVenue.template.label}.</span>
            <small>
              <a
                href={selectedVenue.template.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Inspect source
              </a>
              .
            </small>
            <small>
              {selectedVenue.template.trust === "official"
                ? "Fetched from the venue's official source."
                : selectedVenue.template.trust === "publisher"
                  ? "Publisher-family starting point; confirm the venue-specific options."
                  : "Current community-maintained source; compare it with the official author guide before submission."}
            </small>
          </div>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function ProjectSkeletons() {
  return (
    <div className="project-grid" aria-label="Loading projects">
      {[0, 1, 2].map((item) => (
        <div className="project-card project-card--skeleton" key={item}>
          <i />
          <i />
          <i />
        </div>
      ))}
    </div>
  );
}

function relativeTime(value: string): string {
  const days = Math.floor(
    (Date.now() - new Date(value).getTime()) / 86_400_000,
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
