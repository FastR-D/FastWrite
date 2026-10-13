import { ProductLanding } from "../components/projects/ProductLanding";
import { roleLabel, modelProviderLabel } from "../lib/labels";
import { HarnessProfileEditor } from "../components/workspace/ProjectHarnessProfile";
import { useCallback, useEffect, useState } from "react";
import type {
  PaperProject,
  PublicationTarget,
  PublicationVenueOption,
  WritingProfile,
} from "@fastwrite/shared";
import { WRITING_PROFILES } from "@fastwrite/shared";
import { api } from "../api/client";
import { ImportDialog } from "../components/import/ImportDialog";
import { FastCASDialog } from "../components/FastCASDialog";
import { Button, Checkbox, Dialog, Field, Icon, IconButton, Link, MultiSelect, NumberField, Select, TextArea, TextField, ThemeToggle, icons } from "../components/ui";
import { PublicationTargetFields } from "../components/ui/PublicationTargetFields";
import { navigate, projectPath } from "../lib/navigation";
import { publicationTargetAbbreviation } from "../lib/labels";

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
  const [fastcasOpen, setFastcasOpen] = useState(false);
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
            : "无法加载项目",
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
      .catch(() => undefined);
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
          : "无法接受邀请",
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
    if (!window.confirm(`将项目“${project.name}”移入回收站？`)) return;
    setDeleting(project.id);
    setError("");
    try {
      await api.projects.delete(project.id);
      await loadProjects();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "无法删除项目",
      );
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="projects-page">
      <header className="projects-topbar">
        <Link variant="inherit" className="brand" href="/projects">
          <span className="brand__mark">F</span>
          <span>FastWrite</span>
        </Link>
        <div className="topbar-actions">
          <span className="skill-badge">智能论文写作</span>
          <Button
            size="small"
            variant="ghost"
            icon={<Icon name={icons.organization} />}
            onClick={() => setTeamsOpen(true)}
          >
            团队
          </Button>
          {account ? (
            <Button
              size="small"
              variant="ghost"
              icon={<Icon name={icons.bell} />}
              onClick={() => setNotificationsOpen(true)}
            >
              通知
            </Button>
          ) : null}
          <Button
            size="small"
            variant="ghost"
            icon={account ? <Icon name={icons.signOut} /> : <Icon name={icons.account} />}
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
            {account ? account.displayName : "登录"}
          </Button>
          {account ? <Button size="small" variant="ghost" onClick={() => setFastcasOpen(true)}>账号认证</Button> : null}
          <Link href="/diagrams">科研绘图</Link>
          <ThemeToggle />
        </div>
      </header>
      <FastCASDialog open={fastcasOpen} onClose={() => setFastcasOpen(false)} />
      <main className="projects-main">
        <section className="projects-hero">
          <h1>工作区</h1>
          <div className="projects-hero__actions">
            <Button
              variant="primary"
              icon={<Icon name={icons.add} />}
              onClick={() => setImportOpen(true)}
            >
              导入论文
            </Button>
            <Button
              variant="secondary"
              icon={<Icon name={icons.newFile} />}
              onClick={() => setNewOpen(true)}
            >
              新建论文
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
                    请使用受邀邮箱登录以加入此项目。
                  </span>
                  <Button size="small" onClick={() => setAccountOpen(true)}>
                    登录
                  </Button>
                </>
              ) : invitationState === "accepting" ? (
                "正在接受邀请…"
              ) : invitationState === "accepted" ? (
                "已接受邀请，可在工作区中访问此项目。"
              ) : (
                invitationError || "正在准备邀请…"
              )}
            </div>
          ) : null}
          <div className="section-heading">
            <div>
              <h2 id="recent-projects">最近项目</h2>

            </div>
            <span>
              {projects.length} 个项目
            </span>
          </div>
          {error ? (
            <div className="page-error" role="alert">
              <strong>无法加载项目</strong>
              <span>{error}</span>
              <Button size="small" onClick={() => void loadProjects()}>
                重试
              </Button>
            </div>
          ) : null}
          {loading ? (
            <ProjectSkeletons />
          ) : projects.length === 0 ? (
            <div className="projects-empty">
              <div className="projects-empty__art">
                <Icon name={icons.book} />
              </div>
              <h3>暂无论文</h3>
              <p>
                导入本地目录或 GitHub 仓库，开始使用完整的写作工作区。
              </p>
              <Button
                variant="primary"
                icon={<Icon name={icons.repo} />}
                onClick={() => setImportOpen(true)}
              >
                导入第一篇论文
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
                      <Icon name={icons.book} />
                    </span>
                    <span className="project-card__actions">
                      <Icon name={icons.arrowRight} className="project-card__arrow" />
                      <IconButton
                        className="project-card__delete"
                        label={`删除 ${project.name}`}
                        title="将项目移入回收站"
                        icon={<Icon name={icons.trash} />}
                        disabled={deleting === project.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteProject(project);
                        }}
                      />
                    </span>
                  </div>
                  <h3>{project.name}</h3>
                  <code>{project.mainDocument}</code>
                  <div className="project-card__meta">
                    <span>
                      <Icon name={icons.clockface} /> {relativeTime(project.updatedAt)}
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
  const [providers, setProviders] = useState<{ oidc: boolean; cas: boolean; fastcas: boolean; fastcasSignup: boolean }>({ oidc: false, cas: false, fastcas: false, fastcasSignup: false });
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
        failure instanceof Error ? failure.message : "无法完成认证",
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog
      open={open}
      title={mode === "login" ? "登录" : "创建账号"}
      description="使用 FastWrite 账号访问团队项目和审稿评论。"
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
            {mode === "login" ? "创建账号" : "使用已有账号"}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="account-auth-form"
            loading={loading}
            disabled={!email.trim() || !password}
          >
            {mode === "login" ? "登录" : "创建账号"}
          </Button>
        </>
      }
    >
      <form id="account-auth-form" className="form-stack" onSubmit={(event) => { event.preventDefault(); if (!loading && email.trim() && password) void submit(); }}>
        {mode === "login" && (providers.oidc || providers.cas || providers.fastcas) ? <div className="form-stack">
          {providers.fastcas ? <Button type="button" variant="secondary" onClick={() => window.location.assign("/api/auth/fastcas/login?returnTo=/projects")}>使用 FastCAS 登录</Button> : null}
          {providers.oidc ? <Button type="button" variant="secondary" onClick={() => { window.location.assign(`/api/auth/oidc/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`); }}>使用机构账号登录</Button> : null}
          {providers.cas ? <Button type="button" variant="secondary" onClick={() => { window.location.assign("/api/auth/cas/login"); }}>使用校园 CAS 登录</Button> : null}
        </div> : null}
        {mode === "register" && providers.fastcasSignup ? <Button type="button" variant="secondary" onClick={() => window.location.assign("/api/auth/fastcas/signup?returnTo=/projects")}>通过 FastCAS 创建新账号</Button> : null}
        {mode === "register" ? (
          <Field label="名称">
            <TextField
              value={name}
              onChange={setName}
              name="name"
              autoComplete="name"
              autoFocus
            />
          </Field>
        ) : null}
        <Field label="邮箱">
          <TextField
            value={email}
            onChange={setEmail}
            type="email"
            name="email"
            autoComplete="username"
            autoFocus={mode === "login"}
          />
        </Field>
        <Field label="密码">
          <TextField
            value={password}
            onChange={setPassword}
            type="password"
            name="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </Field>
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

type HarnessProvider = "codex" | "claude" | "openai-compatible";
const HARNESS_PROVIDERS: HarnessProvider[] = ["codex", "claude", "openai-compatible"];

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
        failure instanceof Error ? failure.message : "无法加载团队",
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
            : "无法加载团队策略",
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
          : "无法加载团队管理信息",
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
        failure instanceof Error ? failure.message : "无法创建团队",
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
          : "无法保存团队策略",
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
          : "无法邀请团队成员",
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
          : "无法更新团队成员",
      );
    } finally {
      setBusy(false);
    }
  };
  const removeMember = async (userId: string) => {
    if (!selected || !window.confirm("从团队中移除此成员？"))
      return;
    setBusy(true);
    try {
      await api.teams.removeMember(selected.id, userId);
      await loadGovernance();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "无法移除团队成员",
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
          : "无法更新邀请",
      );
    } finally {
      setBusy(false);
    }
  };
  const saveGroupBinding = async () => {
    if (!selected || !groupValue.trim()) return;
    setBusy(true);
    try { await api.teams.saveGroupBinding(selected.id, "new", { idpGroup: groupValue.trim(), role: groupRole }); setGroupValue(""); await loadGovernance(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法保存身份服务用户组绑定"); }
    finally { setBusy(false); }
  };
  const previewGroupBinding = async () => {
    if (!selected || !groupValue.trim()) return;
    setBusy(true);
    try { setGroupPreview(await api.teams.previewGroupBindings(selected.id, [groupValue.trim()])); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法预览身份服务用户组绑定"); }
    finally { setBusy(false); }
  };
  const removeGroupBinding = async (id: string) => {
    if (!selected) return;
    setBusy(true);
    try { await api.teams.deleteGroupBinding(selected.id, id); await loadGovernance(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法移除身份服务用户组绑定"); }
    finally { setBusy(false); }
  };
  const setAllowedProviders = (providers: string[]) =>
    setPolicy((current) => {
      const next = { ...current };
      const allowed = HARNESS_PROVIDERS.filter((provider) => providers.includes(provider));
      if (allowed.length) next.allowedProviders = allowed;
      else delete next.allowedProviders;
      return next;
    });
  return (
    <Dialog
      open={open}
      title="团队"
      description="创建科研团队、设置默认模型策略并邀请成员。"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="form-stack">
        <Field label="团队">
          <Select
            aria-label="团队"
            value={selectedId}
            onChange={setSelectedId}
            options={[{ value: "", label: "选择团队" }, ...teams.map((team) => ({ value: team.id, label: team.personalUserId ? `${team.name} （个人工作区）` : team.name }))]}
          />
        </Field>
        <Field label="新团队">
          <TextField
            value={name}
            onChange={setName}
            placeholder="应用密码学实验室"
          />
        </Field>
        <Button
          size="small"
          variant="secondary"
          disabled={busy || !name.trim()}
          onClick={() => void create()}
        >
          创建团队
        </Button>
        {selected && !selected.personalUserId ? (
          <>
            <Checkbox
              checked={policy.personalHarness}
              onChange={(checked) =>
                setPolicy((current) => ({
                  ...current,
                  personalHarness: checked,
                }))
              }
            >
              允许个人模型配置
            </Checkbox>
            <Field label="允许的模型服务">
              <MultiSelect
                label="允许的模型服务"
                value={policy.allowedProviders ?? []}
                onChange={setAllowedProviders}
                options={HARNESS_PROVIDERS.map((provider) => ({ value: provider, label: modelProviderLabel(provider) }))}
              />
            </Field>
            <Field label="最大并发任务数">
              <NumberField
                min={1}
                max={100}
                value={policy.maxConcurrentRuns}
                onChange={(next) =>
                  setPolicy((current) => {
                    const updated = { ...current };
                    if (next !== undefined)
                      updated.maxConcurrentRuns = next;
                    else delete updated.maxConcurrentRuns;
                    return updated;
                  })
                }
              />
            </Field>
            <Field label="每日预算（美元）">
              <NumberField
                min={0}
                step={0.01}
                value={policy.dailyBudgetUsd}
                onChange={(next) =>
                  setPolicy((current) => {
                    const updated = { ...current };
                    if (next !== undefined)
                      updated.dailyBudgetUsd = next;
                    else delete updated.dailyBudgetUsd;
                    return updated;
                  })
                }
              />
            </Field>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => void savePolicy()}
            >
              保存模型策略
            </Button>
            {canManageMembers ? <HarnessProfileEditor key={selected.id} scope="team" teamId={selected.id}/> : null}
            {canManageMembers ? <div className="field" role="group" aria-labelledby="idp-group-bindings-title">
              <span id="idp-group-bindings-title">身份服务用户组绑定</span>
              <Field label="包含身份服务来源的用户组"><TextField value={groupValue} onChange={(next) => { setGroupValue(next); setGroupPreview([]); }} placeholder="https://idp.example:lab-members" /></Field>
              <Field label="映射角色"><Select aria-label="映射角色" value={groupRole} onChange={(next) => setGroupRole(next as "admin" | "member")} options={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }]} /></Field>
              <div className="settings-agent__actions"><Button size="small" variant="secondary" disabled={busy || !groupValue.trim()} onClick={() => void previewGroupBinding()}>预览</Button><Button size="small" variant="secondary" disabled={busy || !groupValue.trim()} onClick={() => void saveGroupBinding()}>添加绑定</Button></div>
              {groupPreview.length ? <small>匹配人数： {groupPreview.map((binding) => `${binding.idpGroup} (${roleLabel(binding.role)})`).join(", ")}</small> : null}
              {groupBindings.map((binding) => <div className="team-governance-row" key={binding.id}><span>{binding.idpGroup} <small>{roleLabel(binding.role)}</small></span><Button size="small" variant="ghost" disabled={busy} onClick={() => void removeGroupBinding(binding.id)}>移除</Button></div>)}
            </div> : null}
            <Field label="邀请团队成员">
              <TextField
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="researcher@university.edu"
              />
            </Field>
            <Field label="团队角色">
              <Select
                aria-label="团队角色"
                value={role}
                onChange={(next) => setRole(next as typeof role)}
                options={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }]}
              />
            </Field>
            <Field label="到期时间（可选）">
              <TextField type="datetime-local" value={inviteExpiresAt} onChange={setInviteExpiresAt} />
            </Field>
            <Field label="留言（可选）">
              <TextArea rows={3} maxLength={2000} value={inviteMessage} onChange={setInviteMessage} />
            </Field>
            <Button
              size="small"
              variant="secondary"
              disabled={busy || !email.trim()}
              onClick={() => void invite()}
            >
              创建邀请
            </Button>
            {invitationLink ? (
              <Field label="邀请链接（仅显示一次）">
                <TextField
                  readonly
                  value={invitationLink}
                />
              </Field>
            ) : null}
            <div className="field" role="group" aria-labelledby="team-members-title">
              <span id="team-members-title">成员</span>
              {members.map((member) => (
                <div className="team-governance-row" key={member.userId}>
                  <span>
                    {member.user.displayName}{" "}
                    <small>{member.user.emailNormalized}</small>
                  </span>
                  {member.role === "owner" ? (
                    <strong>所有者</strong>
                  ) : canManageMembers ? (
                    <>
                      <Select
                        aria-label={`成员角色： ${member.user.displayName}`}
                        value={member.role}
                        disabled={busy}
                        onChange={(next) =>
                          void changeMemberRole(
                            member.userId,
                            next as "admin" | "member",
                          )
                        }
                        options={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }]}
                      />
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void removeMember(member.userId)}
                      >
                        移除
                      </Button>
                    </>
                  ) : (
                    <strong>{roleLabel(member.role)}</strong>
                  )}
                </div>
              ))}
              {!members.length ? <small>暂无成员。</small> : null}
            </div>
            <div className="field" role="group" aria-labelledby="team-invitations-title">
              <span id="team-invitations-title">邀请</span>
              {invitations.map((invitation) => (
                <div className="team-governance-row" key={invitation.id}>
                  <span>
                    {invitation.emailNormalized}{" "}
                    <small>
                      {roleLabel(invitation.role)} ·{" "}
                      {invitation.acceptedAt
                        ? "accepted"
                        : invitation.revokedAt
                          ? "revoked"
                          : "待处理"}
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
                        重新发送
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void manageInvitation(invitation.id, "revoke")
                        }
                      >
                        撤销
                      </Button>
                    </>
                  ) : null}
                </div>
              ))}
              {!invitations.length ? (
                <small>暂无邀请。</small>
              ) : null}
            </div>
          </>
        ) : selected ? (
          <p className="dialog-copy">
            个人工作区不提供共享模型策略或团队邀请。
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
          : "无法加载通知",
      );
    }
  }, []);
  useEffect(() => {
    if (open) void load();
  }, [load, open]);
  return (
    <Dialog
      open={open}
      title="通知"
      description="项目访问与协作动态。"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
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
            <strong>{notification.title.replace(/ requested access$/, " 申请访问项目").replace("You were mentioned in a comment", "有人在评论中提及了你").replace("Project access approved", "项目访问申请已批准").replace("Project access request declined", "项目访问申请已拒绝")}</strong>
            {notification.body ? ` ${notification.body.replace(/^Comment thread /, "评论讨论 ")}` : ""} ·{" "}
            {new Date(notification.createdAt).toLocaleString("zh-CN")}{" "}
            {!notification.readAt ? (
              <Button
                size="small"
                variant="ghost"
                onClick={async () => {
                  await api.notifications.markRead(notification.id);
                  await load();
                }}
              >
                标记已读
              </Button>
            ) : null}
          </p>
        ))}
        <div className="notification-preferences" aria-label="通知设置">
          <strong>通知接收方式</strong>
          {preferences.map((preference) => (
            <div className="notification-preference-row" key={preference.type}>
              <span>{notificationPreferenceLabel(preference.type)}</span>
              <Checkbox checked={preference.inApp} onChange={async (checked) => { await api.notifications.updatePreference(preference.type, { inApp: checked }); await load(); }}>站内</Checkbox>
              <Checkbox checked={preference.email} onChange={async (checked) => { await api.notifications.updatePreference(preference.type, { email: checked }); await load(); }}>邮箱</Checkbox>
            </div>
          ))}
        </div>
        {!notifications.length && !error ? (
          <p className="sidebar-empty">暂无通知。</p>
        ) : null}
      </div>
    </Dialog>
  );
}

function notificationPreferenceLabel(type: "access_request" | "access_request_decision" | "mention") {
  if (type === "access_request") return "访问申请";
  if (type === "access_request_decision") return "访问审批结果";
  return "评论提及";
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
          : "无法创建项目",
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="创建新论文"
      description={
        selectedVenue?.template
          ? "使用所选会议或期刊的完整 LaTeX 模板开始写作。"
          : "使用可编译的最简 LaTeX 文档开始写作。"
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={loading}
            disabled={!name.trim()}
            onClick={() => void create()}
          >
            创建论文
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="项目名称">
          <TextField
            value={name}
            onChange={setName}
            placeholder="我的安全研究论文"
            autoFocus
          />
        </Field>
        {teams.length ? (
          <Field label="工作区">
            <Select
              aria-label="工作区"
              value={teamId}
              onChange={setTeamId}
              options={teams.map((team) => ({ value: team.id, label: team.personalUserId ? `${team.name} （个人）` : team.name }))}
            />
          </Field>
        ) : null}
        <Field label="研究领域" hint="研究领域与所选会议或期刊共同指导全部写作流程。">
          <Select
            aria-label="研究领域"
            value={profile}
            onChange={(next) => {
              setProfile(next as WritingProfile);
              setPublicationTarget(undefined);
              setSelectedVenue(undefined);
            }}
            options={WRITING_PROFILES.map((item) => ({ value: item.value, label: item.label }))}
          />
        </Field>
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
              <Link
                href={selectedVenue.template.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                查看来源
              </Link>
              .
            </small>
            <small>
              {selectedVenue.template.trust === "official"
                ? "获取自会议或期刊的官方来源。"
                : selectedVenue.template.trust === "publisher"
                  ? "使用出版社通用模板，请确认会议或期刊的具体选项。"
                  : "使用当前社区维护的模板，投稿前请与官方作者指南核对。"}
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
    <div className="project-grid" aria-label="正在加载项目">
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
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
