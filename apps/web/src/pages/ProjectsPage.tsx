import { BrandMark } from "../components/BrandMark";
import { userFacingError } from "../lib/notifications";
import { ProductLanding } from "../components/projects/ProductLanding";
import { useCallback, useEffect, useId, useState } from "react";
import type {
  PaperProject,
  PublicationTarget,
  PublicationVenueOption,
  WritingProfile,
} from "@fastwrite/shared";
import { api, ApiClientError } from "../api/client";
import { ImportDialog } from "../components/import/ImportDialog";
import { FastCASDialog } from "../components/FastCASDialog";
import { Button, Checkbox, Dialog, Field, Icon, Link, Select, TextArea, TextField, ThemeToggle, icons } from "../components/ui";
import { PublicationTargetPicker } from "../components/ui/PublicationTargetPicker";
import { navigate, projectPath } from "../lib/navigation";
import { ProjectBrowser, type ProjectListState } from "../components/projects/ProjectBrowser";
import styles from "./ProjectsPage.module.css";

type ProjectAccount = Awaited<ReturnType<typeof api.auth.me>>;
const initialProjectList: ProjectListState = { projects: [], loading: true, error: "" };

export function ProjectsPage() {
  const invitationToken = new URLSearchParams(window.location.search).get(
    "invite",
  );
  const [relatedProjects, setRelatedProjects] = useState(initialProjectList);
  const [siteProjects, setSiteProjects] = useState(initialProjectList);
  const [projectListRevision, setProjectListRevision] = useState(0);
  const [deleteError, setDeleteError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [fastcasOpen, setFastcasOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [account, setAccount] = useState<ProjectAccount | null>(null);
  const accountId = account?.id;
  const isPlatformAdmin = account?.platformRole === "platform_admin";
  const [invitationState, setInvitationState] = useState<
    "idle" | "accepting" | "accepted" | "error"
  >(invitationToken ? "idle" : "idle");
  const [invitationError, setInvitationError] = useState("");

  const refreshProjects = useCallback(() => {
    setDeleteError("");
    setProjectListRevision(revision => revision + 1);
  }, []);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    const load = async (list: typeof api.projects.list, setList: typeof setRelatedProjects) => {
      setList(current => ({ ...current, loading: true, error: "" }));
      try {
        const projects = await list(controller.signal);
        if (!controller.signal.aborted) setList({ projects, loading: false, error: "" });
      } catch (failure) {
        if (!controller.signal.aborted) {
          const accessDenied = failure instanceof ApiClientError && (failure.status === 401 || failure.status === 403);
          setList(current => ({
            projects: accessDenied ? [] : current.projects,
            loading: false,
            error: userFacingError(failure, "无法加载项目"),
          }));
        }
      }
    };
    void load(api.projects.list, setRelatedProjects);
    if (isPlatformAdmin) void load(api.admin.projects, setSiteProjects);
    return () => controller.abort();
  }, [accountId, isPlatformAdmin, projectListRevision]);
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
      window.history.replaceState({}, "", "/panel");
      refreshProjects();
    } catch (failure) {
      setInvitationState("error");
      setInvitationError(
        userFacingError(failure, "无法接受邀请"),
      );
    }
  }, [account, invitationState, invitationToken, refreshProjects]);

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
    setDeleteError("");
    try {
      await api.projects.delete(project.id);
      refreshProjects();
    } catch (failure) {
      setDeleteError(
        userFacingError(failure, "无法删除项目"),
      );
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className={styles.page}>
      <header className={`projects-topbar ${styles.topbar}`}>
        <Link variant="inherit" className="brand" href="/panel">
          <BrandMark />
          <span>FastWrite</span>
        </Link>
        <div className="topbar-actions">
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
                    setRelatedProjects(initialProjectList);
                    setSiteProjects(initialProjectList);
                    setDeleteError("");
                  })
                : setAccountOpen(true)
            }
          >
            {account ? account.displayName : "登录"}
          </Button>
          {account ? <Button size="small" variant="ghost" onClick={() => setFastcasOpen(true)}>账号认证</Button> : null}
          <ThemeToggle />
        </div>
      </header>
      <FastCASDialog open={fastcasOpen} onClose={() => setFastcasOpen(false)} />
      <ProjectBrowser
        canManageUsers={isPlatformAdmin}
        currentUserId={account.id}
        relatedProjects={relatedProjects}
        siteProjects={isPlatformAdmin ? siteProjects : undefined}
        deleteError={deleteError}
        deleting={deleting}
        onNew={() => setNewOpen(true)}
        onImport={() => setImportOpen(true)}
        onRetry={refreshProjects}
        onDelete={(project) => void deleteProject(project)}
        onUpdated={refreshProjects}
        notice={invitationToken ? (
          <div
            className={invitationState === "error" ? "page-error" : "form-notice"}
            role={invitationState === "error" ? "alert" : "status"}
          >
            {invitationState === "accepting" ? "正在接受邀请…"
              : invitationState === "accepted" ? "已接受邀请，可在工作区中访问此项目。"
              : invitationError || "正在准备邀请…"}
          </div>
        ) : null}
      />
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
        }}
      />
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
  onAuthenticated: (user: ProjectAccount) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<{ registration: boolean; oidc: boolean; cas: boolean; fastcas: boolean; fastcasSignup: boolean }>({ registration: false, oidc: false, cas: false, fastcas: false, fastcasSignup: false });
  useEffect(() => { if (open) void api.auth.providers().then((value) => { setProviders(value); if (!value.registration) setMode("login"); }).catch(() => undefined); }, [open]);
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
        userFacingError(failure, "无法完成认证"),
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
          {providers.registration ? <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
          >
            {mode === "login" ? "创建账号" : "使用已有账号"}
          </Button> : null}
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
          {providers.fastcas ? <Button type="button" variant="secondary" onClick={() => window.location.assign("/api/auth/fastcas/login?returnTo=/panel")}>使用 FastCAS 登录</Button> : null}
          {providers.oidc ? <Button type="button" variant="secondary" onClick={() => { window.location.assign(`/api/auth/oidc/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`); }}>使用机构账号登录</Button> : null}
          {providers.cas ? <Button type="button" variant="secondary" onClick={() => { window.location.assign("/api/auth/cas/login"); }}>使用校园 CAS 登录</Button> : null}
        </div> : null}
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
      threadId?: string;
      readAt?: string;
      createdAt: string;
    }>
  >([]);
  const [preferences, setPreferences] = useState<
    Array<{
      type: "access_request" | "access_request_decision" | "mention" | "discussion";
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
        userFacingError(failure, "无法加载通知"),
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
            {notification.projectId ? <Button size="small" variant="ghost" onClick={() => { onClose(); navigate(`${projectPath(notification.projectId!)}${notification.threadId ? `?discussion=${encodeURIComponent(notification.threadId)}` : ""}`); }}>{notification.threadId ? "查看讨论" : "打开项目"}</Button> : null}
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

function notificationPreferenceLabel(type: "access_request" | "access_request_decision" | "mention" | "discussion") {
  if (type === "access_request") return "访问申请";
  if (type === "access_request_decision") return "访问审批结果";
  if (type === "discussion") return "讨论回复与建议审批";
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
  const formId = useId();
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
    const controller = new AbortController();
    void api.teams.list(controller.signal).then(items => {
      if (controller.signal.aborted) return;
      const available = items.filter(team => !team.personalUserId && (team.role === "owner" || team.role === "admin"));
      setTeams(available);
      setTeamId(current => available.some(team => team.id === current) ? current : "");
    }).catch(() => { if (!controller.signal.aborted) { setTeams([]); setTeamId(""); } });
    return () => controller.abort();
  }, [open]);
  const create = async () => {
    if (loading || !name.trim()) return;
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
        userFacingError(createError, "无法创建项目"),
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="创建新论文"
      className={styles.newPaperDialog!}
      onClose={() => { if (!loading) onClose(); }}
      footer={
        <>
          <Button variant="ghost" disabled={loading} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={loading}
            disabled={loading || !name.trim()}
            type="submit"
            form={formId}
          >
            创建论文
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.newPaperForm} onSubmit={event => { event.preventDefault(); void create(); }}>
        <div className={styles.newPaperIdentity}>
          <Field label="项目名称"><TextField aria-label="项目名称" value={name} onChange={setName} placeholder="我的研究论文" disabled={loading} required autoFocus /></Field>
          <Field label="所属团队"><Select aria-label="所属团队" value={teamId} onChange={setTeamId} disabled={loading} portal options={[{ value: "", label: "个人论文" }, ...teams.map(team => ({ value: team.id, label: team.name }))]} /></Field>
        </div>
        <div className={styles.publicationPath}>
          <span>研究领域与目标</span>
          <PublicationTargetPicker profile={profile} onProfileChange={setProfile} value={publicationTarget} onChange={setPublicationTarget} onSelectedVenueChange={setSelectedVenue} disabled={loading} />
        </div>
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
      </form>
    </Dialog>
  );
}
