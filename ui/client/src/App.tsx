import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Grid3X3,
  Home,
  Loader2,
  List,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Trash2,
  Users,
  Wrench,
  X
} from "lucide-react";

type SkillSummary = {
  name: string;
  title?: string;
  description: string;
  version: string;
  tags: string[];
  category?: string;
  agents: string[];
  actions: string[];
  resource_count: number;
  capabilities: {
    network: boolean;
    filesystem: "readonly" | "readwrite";
    tools: string[];
  };
};

type SkillDetail = SkillSummary & {
  skill_md: string;
  frontmatter: Record<string, unknown>;
  resources: Array<{ path: string; type: string }>;
  bin: Record<string, {
    command: string;
    args: string[];
    description?: string;
    requiresTty: boolean;
  }>;
  bundle: {
    root: "SKILL.md";
    files: SkillBundleFile[];
  };
  provenance: SkillProvenance;
};

type SkillBundleFile = {
  path: string;
  kind: "markdown" | "data" | "script" | "svg" | "text" | "file";
  group: "root" | "resources" | "actions";
  title: string;
  type: string;
  summary: string;
  preview_status: "loaded" | "unavailable";
  preview?: string;
};

type SkillProvenance = {
  integrity: "signed";
  source: {
    status: "present" | "legacy" | "tampered" | "unparseable" | "absent";
    label: string;
    identifier?: string;
    fetched_at?: string;
    content_hash?: string;
    reason?: string;
  };
};

type ProfileMembership = {
  name: string;
  agent: string;
  target: string;
  include_tags: "*" | string[];
  exclude_tags: string[];
  export_skill_overrides?: boolean | string;
  skills: string[];
};

type ProfilesResult = {
  configPath: string;
  profiles: ProfileMembership[];
};

type UpdatesResult = {
  drifted: Array<{ name: string; reason: string }>;
  up_to_date: string[];
  unchecked: Array<{ name: string; reason: string }>;
  errors: Array<{ name: string; error: string }>;
  warnings: Array<{ name: string; warning: string }>;
};

type SyncUpdatePolicy = "auto_apply" | "user_approve" | "admin_hold";

type SyncUpdateResource = {
  id: string;
  upstream_id: string;
  upstream_name: string;
  kind: "skill" | "agent" | "mcp_server" | "collection";
  name: string;
  installed_version: string | null;
  available_version: string;
  channel: string;
  changelog: string;
  publisher: string;
  policy: SyncUpdatePolicy;
  policy_action: SyncUpdatePolicy;
  installable: boolean;
  breaking: boolean;
  capabilities: SkillSummary["capabilities"];
  bundle_hash: string;
  signature: {
    algorithm: "ed25519";
    public_key: string;
    signature: string;
  };
};

type SyncUpdatesResult = {
  resources: SyncUpdateResource[];
  errors: Array<{ upstream_id: string; error: string }>;
};

type UpdatesPayload = {
  updates: UpdatesResult;
  sync: SyncUpdatesResult;
};

type AccountInfo = {
  mode: "local" | "remote";
  label: string;
  provider: string;
};

type AbilitySet = {
  can_add_skill: boolean;
  can_manage_users: boolean;
  can_invite_users: boolean;
  can_manage_billing: boolean;
  can_install_local: boolean;
  can_manage_upstreams: boolean;
};

type PermissionsResult = {
  mode: "local" | "remote";
  roles: string[];
  account?: AccountInfo;
  abilities?: AbilitySet;
  capability_groups: Array<{ name: string; description: string; tags: string[] }>;
};

type DashboardContext = {
  mode: "local" | "remote";
  api_version: string;
  ui_bundle_version: string;
  ui_channel: string;
  ui_delivery: {
    source: string;
    fallback_reason?: string;
  };
  abilities: AbilitySet;
  account: AccountInfo;
  vault: {
    mode: "local" | "remote";
    storage_path: string;
    db_path?: string;
  };
  compatibility: {
    status: "compatible" | "upgrade_required" | "too_new" | "unknown";
    api_version: string;
    min_api_version: string;
    max_api_version?: string;
    reason?: string;
  };
};

type EnrolledUpstream = {
  id: string;
  name: string;
  type: "file";
  catalog_path: string;
  public_key: string;
  enrollment: {
    status: "pending" | "active" | "revoked";
    device_id: string;
    device_public_key: string;
    enrolled_at: string;
    revoked_at?: string;
    last_check_in_at?: string;
  };
};

type UpstreamsResult = {
  upstreams: EnrolledUpstream[];
};

type View = "home" | "skills" | "profiles" | "updates" | "permissions" | "users";
type SkillViewMode = "grid" | "list";
type SkillSortKey = "name" | "agent" | "version" | "resources";
type SkillFilterKey = "all" | "network" | "filesystem" | "actions" | "unassigned";
type SkillDetailTab = "files" | "overview" | "permissions" | "provenance" | "edit";

type AddSkillPayload =
  | { source: "inline"; identifier?: string; skill_md: string }
  | { source: "github" | "agentskills" | "url"; identifier: string }
  | { source: "local"; identifier?: string; skill_dir: string };

type ApiInit = Omit<RequestInit, "body"> & {
  body?: unknown;
};

export function App() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [profiles, setProfiles] = useState<ProfilesResult | null>(null);
  const [updates, setUpdates] = useState<UpdatesPayload | null>(null);
  const [permissions, setPermissions] = useState<PermissionsResult | null>(null);
  const [upstreams, setUpstreams] = useState<UpstreamsResult | null>(null);
  const [context, setContext] = useState<DashboardContext | null>(null);
  const [view, setView] = useState<View>("home");
  const [skillViewMode, setSkillViewMode] = useState<SkillViewMode>("grid");
  const [skillSortKey, setSkillSortKey] = useState<SkillSortKey>("name");
  const [skillFilterKey, setSkillFilterKey] = useState<SkillFilterKey>("all");
  const [query, setQuery] = useState("");
  const [addSkillOpen, setAddSkillOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (!skillMatchesFilter(skill, skillFilterKey)) return false;
      if (!needle) return true;
      return [
        skill.name,
        skill.title ?? "",
        skill.description,
        skill.category ?? "",
        ...skill.tags,
        ...skill.agents
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [query, skillFilterKey, skills]);

  const visibleSkills = useMemo(
    () => [...filteredSkills].sort((left, right) => compareSkills(left, right, skillSortKey)),
    [filteredSkills, skillSortKey]
  );

  const syncUpdateCount = updates?.sync.resources.length ?? 0;
  const sourceReviewCount =
    (updates?.updates.drifted.length ?? 0) +
    (updates?.updates.errors.length ?? 0);
  const updateReviewCount = syncUpdateCount + sourceReviewCount;
  const upstreamCount = upstreams?.upstreams.length ?? 0;
  const roleCount = permissions?.roles.length ?? 0;

  async function refreshSkills(nextSelectedName?: string | null): Promise<void> {
    const body = await api<{ skills: SkillSummary[] }>("/skills");
    setSkills(body.skills);
    setSelectedName((current) => {
      if (nextSelectedName !== undefined) return nextSelectedName;
      if (current && body.skills.some((skill) => skill.name === current)) return current;
      return null;
    });
  }

  async function refreshProfiles(): Promise<void> {
    const body = await api<{ profiles: ProfilesResult }>("/profiles");
    setProfiles(body.profiles);
  }

  async function refreshUpdates(): Promise<void> {
    const body = await api<{ updates: UpdatesResult; sync?: SyncUpdatesResult }>("/updates");
    setUpdates({
      updates: body.updates,
      sync: body.sync ?? { resources: [], errors: [] }
    });
  }

  async function refreshPermissions(): Promise<void> {
    const body = await api<{ permissions: PermissionsResult }>("/permissions");
    setPermissions(body.permissions);
  }

  async function refreshUpstreams(): Promise<void> {
    const body = await api<UpstreamsResult>("/upstreams");
    setUpstreams(body);
  }

  async function refreshContext(): Promise<void> {
    try {
      const body = await api<{ context: DashboardContext }>("/context");
      setContext(body.context);
    } catch (contextError) {
      if (contextError instanceof ApiRequestError && contextError.status === 404) {
        setContext(upgradeRequiredContext("This dashboard bundle requires a newer AutoVault management API."));
        return;
      }
      throw contextError;
    }
  }

  async function refreshAll(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([
        refreshContext(),
        refreshSkills(),
        refreshProfiles(),
        refreshUpdates(),
        refreshPermissions(),
        refreshUpstreams()
      ]);
    } catch (refreshError) {
      setError(errorMessage(refreshError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (!selectedName) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setError(null);
    void api<{ skill: SkillDetail }>(`/skills/${encodeURIComponent(selectedName)}`)
      .then((body) => {
        if (!cancelled) setDetail(body.skill);
      })
      .catch((detailError) => {
        if (!cancelled) setError(errorMessage(detailError));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedName]);

  async function saveSkill(name: string, payload: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ skill: SkillDetail }>(
        `/skills/${encodeURIComponent(name)}/frontmatter`,
        {
          method: "PATCH",
          body: payload
        }
      );
      setDetail(body.skill);
      await Promise.all([refreshSkills(name), refreshProfiles(), refreshUpdates()]);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function createSkill(payload: AddSkillPayload): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ skill: SkillDetail; result: unknown }>("/skills", {
        method: "POST",
        body: payload
      });
      await Promise.all([refreshSkills(body.skill.name), refreshProfiles(), refreshUpdates()]);
      setSelectedName(body.skill.name);
      setDetail(body.skill);
      setView("skills");
      setAddSkillOpen(false);
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSkill(name: string): Promise<void> {
    if (!window.confirm(`Delete ${name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
        body: { confirm: true }
      });
      await Promise.all([refreshSkills(null), refreshProfiles(), refreshUpdates()]);
      setDetail(null);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setBusy(false);
    }
  }

  async function saveProfiles(nextProfiles: EditableProfile[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        profiles: nextProfiles.map((profile) => ({
          name: profile.name,
          agent: profile.agent,
          target: profile.target,
          include_tags: profile.includeTags.trim() === "*"
            ? "*"
            : splitCsv(profile.includeTags),
          exclude_tags: splitCsv(profile.excludeTags),
          export_skill_overrides: profile.exportSkillOverrides
        }))
      };
      const body = await api<{ profiles: ProfilesResult }>("/profiles", {
        method: "PUT",
        body: payload
      });
      setProfiles(body.profiles);
    } catch (profileError) {
      setError(errorMessage(profileError));
    } finally {
      setBusy(false);
    }
  }

  async function syncProfiles(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api("/profiles/sync", { method: "POST" });
      await refreshProfiles();
    } catch (syncError) {
      setError(errorMessage(syncError));
    } finally {
      setBusy(false);
    }
  }

  async function updateSkill(name: string): Promise<void> {
    if (!window.confirm(`Update ${name} from its recorded source?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/skills/${encodeURIComponent(name)}/update`, {
        method: "POST",
        body: { confirm: true }
      });
      await Promise.all([refreshSkills(name), refreshUpdates()]);
    } catch (updateError) {
      setError(errorMessage(updateError));
    } finally {
      setBusy(false);
    }
  }

  async function installSyncUpdate(resource: SyncUpdateResource): Promise<void> {
    const needsApproval = resource.policy === "user_approve" || resource.breaking;
    if (needsApproval && !window.confirm(`Install ${resource.name} ${resource.available_version} from ${resource.upstream_name}?`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/resources/${encodeURIComponent(resource.id)}/install`, {
        method: "POST",
        body: {
          upstream_id: resource.upstream_id,
          accept: resource.policy === "user_approve" ? true : undefined
        }
      });
      await Promise.all([
        refreshSkills(resource.name),
        refreshProfiles(),
        refreshUpdates(),
        refreshUpstreams()
      ]);
      setSelectedName(resource.name);
    } catch (installError) {
      setError(errorMessage(installError));
    } finally {
      setBusy(false);
    }
  }

  async function revokeUpstream(upstream: EnrolledUpstream): Promise<void> {
    if (!window.confirm(`Revoke ${upstream.name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api("/enrollments/revoke", {
        method: "POST",
        body: { upstream_id: upstream.id }
      });
      await Promise.all([refreshUpstreams(), refreshUpdates()]);
    } catch (revokeError) {
      setError(errorMessage(revokeError));
    } finally {
      setBusy(false);
    }
  }

  if (context?.compatibility.status === "upgrade_required") {
    return <UpgradeRequiredScreen context={context} />;
  }

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="AutoVault navigation">
        <div className="brand">
          <VaultMark />
          <div>
            <h1>AutoVault</h1>
            <p>Local control plane</p>
          </div>
        </div>

        <div className="control-strip" aria-label="Vault summary">
          <div className="control-stat">
            <strong>{skills.length}</strong>
            <span>skills</span>
          </div>
          <div className="control-stat">
            <strong>{updateReviewCount}</strong>
            <span>updates</span>
          </div>
          <div className="control-stat">
            <strong>{upstreamCount}</strong>
            <span>upstreams</span>
          </div>
          <div className="control-stat">
            <strong>{roleCount}</strong>
            <span>roles</span>
          </div>
        </div>

        <nav className="nav">
          <NavButton active={view === "home"} icon={<Home />} onClick={() => setView("home")}>
            Home
          </NavButton>
          <NavButton
            active={view === "skills"}
            icon={<FileText />}
            onClick={() => {
              setSelectedName(null);
              setView("skills");
            }}
          >
            Skills
          </NavButton>
          <NavButton active={view === "profiles"} icon={<Users />} onClick={() => setView("profiles")}>
            Profiles
          </NavButton>
          <NavButton active={view === "updates"} icon={<RefreshCw />} onClick={() => setView("updates")}>
            Updates
          </NavButton>
          <NavButton
            active={view === "permissions"}
            icon={<ShieldCheck />}
            onClick={() => setView("permissions")}
          >
            Permissions
          </NavButton>
          <NavButton active={view === "users"} icon={<Users />} onClick={() => setView("users")}>
            Users
          </NavButton>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <div>
              <span className="micro-label">control plane / {view}</span>
              <h2>{headingFor(view, detail)}</h2>
            </div>
            <TopNavigation
              view={view}
              onNavigate={(nextView) => {
                if (nextView === "skills") setSelectedName(null);
                setView(nextView);
              }}
            />
          </div>
          <div className="topbar-actions">
            <AccountSummary permissions={permissions} context={context} />
            <button className="primary-button" onClick={() => setAddSkillOpen(true)} disabled={busy}>
              <Plus />
              Add skill
            </button>
            <button className="icon-button" onClick={() => void refreshAll()} disabled={loading || busy}>
              {loading ? <Loader2 className="spin" /> : <RefreshCw />}
              Refresh
            </button>
          </div>
        </header>

        <AddSkillDialog
          open={addSkillOpen}
          busy={busy}
          onClose={() => setAddSkillOpen(false)}
          onCreate={createSkill}
        />

        {error ? (
          <div className="notice error">
            <AlertTriangle />
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="empty-state av-state-scan">
            <Loader2 className="spin" />
            <span>Loading vault</span>
          </div>
        ) : view === "home" ? (
          <HomeView
            skills={skills}
            profiles={profiles}
            updates={updates}
            upstreams={upstreams}
            permissions={permissions}
            onBrowseSkills={() => {
              setSelectedName(null);
              setView("skills");
            }}
            onNavigate={setView}
          />
        ) : view === "skills" ? (
          detail ? (
            <SkillEditor
              key={detail.name}
              detail={detail}
              busy={busy}
              onBack={() => setSelectedName(null)}
              onSave={saveSkill}
              onDelete={deleteSkill}
              onUpdate={updateSkill}
            />
          ) : (
            <SkillsCollection
              skills={visibleSkills}
              totalSkills={skills.length}
              query={query}
              filterKey={skillFilterKey}
              sortKey={skillSortKey}
              viewMode={skillViewMode}
              onQueryChange={setQuery}
              onFilterChange={setSkillFilterKey}
              onSortChange={setSkillSortKey}
              onViewModeChange={setSkillViewMode}
              onOpenSkill={(name) => setSelectedName(name)}
            />
          )
        ) : view === "profiles" ? (
          <ProfileEditor
            key={`${profiles?.configPath ?? "profiles"}:${profiles?.profiles.length ?? 0}`}
            profiles={profiles}
            busy={busy}
            onSave={saveProfiles}
            onSync={syncProfiles}
          />
        ) : view === "updates" ? (
          <UpdatesPanel
            updates={updates}
            onRefresh={refreshUpdates}
            onInstall={installSyncUpdate}
            busy={busy}
          />
        ) : view === "permissions" ? (
          <PermissionsPanel
            permissions={permissions}
            upstreams={upstreams}
            busy={busy}
            onRevoke={revokeUpstream}
          />
        ) : (
          <UsersPanel permissions={permissions} upstreams={upstreams} />
        )}
      </section>
    </main>
  );
}

function NavButton({
  active,
  icon,
  children,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

function TopNavigation({
  view,
  onNavigate
}: {
  view: View;
  onNavigate: (view: View) => void;
}) {
  const items: Array<{ view: View; label: string }> = [
    { view: "home", label: "Home" },
    { view: "skills", label: "Skills" },
    { view: "updates", label: "Updates" },
    { view: "profiles", label: "Profiles" },
    { view: "users", label: "Users" }
  ];
  return (
    <nav className="top-nav" aria-label="Primary dashboard navigation">
      {items.map((item) => (
        <button
          key={item.view}
          className={view === item.view ? "active" : ""}
          onClick={() => onNavigate(item.view)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function AccountSummary({
  permissions,
  context
}: {
  permissions: PermissionsResult | null;
  context: DashboardContext | null;
}) {
  const account = context?.account ?? permissions?.account ?? {
    mode: "local" as const,
    label: "Local operator",
    provider: "loopback session"
  };
  const delivery = context
    ? `UI ${context.ui_bundle_version} · ${context.ui_delivery.source}`
    : "UI bundled";
  return (
    <div className="account-card" aria-label="Account context">
      <span className="status-dot" />
      <span>
        <strong>{account.label}</strong>
        <small>{account.mode} · {account.provider} · {delivery}</small>
      </span>
    </div>
  );
}

function UpgradeRequiredScreen({ context }: { context: DashboardContext }) {
  return (
    <main className="upgrade-screen">
      <section className="panel upgrade-panel av-state-held">
        <div className="brand upgrade-brand">
          <VaultMark />
          <div>
            <span className="micro-label">dashboard paused</span>
            <h1>AutoVault needs an upgrade</h1>
          </div>
        </div>
        <p>
          This dashboard bundle expects management API {context.compatibility.min_api_version}.
          The local CLI is serving {context.compatibility.api_version}.
        </p>
        <div className="upgrade-grid">
          <div>
            <span>UI bundle</span>
            <strong>{context.ui_bundle_version}</strong>
          </div>
          <div>
            <span>Channel</span>
            <strong>{context.ui_channel}</strong>
          </div>
          <div>
            <span>Source</span>
            <strong>{context.ui_delivery.source}</strong>
          </div>
        </div>
        <code>autovault update</code>
      </section>
    </main>
  );
}

function AddSkillDialog({
  open,
  busy,
  onClose,
  onCreate
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (payload: AddSkillPayload) => Promise<void>;
}) {
  const [source, setSource] = useState<AddSkillPayload["source"]>("inline");
  const [identifier, setIdentifier] = useState("");
  const [skillMd, setSkillMd] = useState("");
  const [skillDir, setSkillDir] = useState("");

  if (!open) return null;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (source === "inline") {
      void onCreate({
        source,
        identifier: identifier.trim() || undefined,
        skill_md: skillMd
      });
      return;
    }
    if (source === "local") {
      void onCreate({
        source,
        identifier: identifier.trim() || undefined,
        skill_dir: skillDir.trim()
      });
      return;
    }
    void onCreate({
      source,
      identifier: identifier.trim()
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="panel add-skill-dialog av-state-scan" onSubmit={submit}>
        <div className="panel-header">
          <div>
            <span className="micro-label">admit skill</span>
            <h3>Add skill</h3>
            <p>Install through AutoVault validation, signing, and profile sync.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy}>
            <X />
            Close
          </button>
        </div>

        <label>
          Source
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as AddSkillPayload["source"])}
          >
            <option value="inline">Paste SKILL.md</option>
            <option value="github">GitHub</option>
            <option value="url">URL</option>
            <option value="agentskills">AgentSkills</option>
            <option value="local">Local folder</option>
          </select>
        </label>

        {source === "local" ? (
          <label>
            Skill folder
            <input
              value={skillDir}
              onChange={(event) => setSkillDir(event.target.value)}
              placeholder="/path/to/skill"
              required
            />
          </label>
        ) : (
          <label>
            Identifier
            <input
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder={source === "inline" ? "dashboard-paste" : "repo/path, URL, or upstream id"}
              required={source !== "inline"}
            />
          </label>
        )}

        {source === "inline" ? (
          <label>
            SKILL.md
            <textarea
              value={skillMd}
              onChange={(event) => setSkillMd(event.target.value)}
              placeholder={"---\nname: my-skill\ndescription: ...\n---\n\n# my-skill"}
              rows={12}
              required
            />
          </label>
        ) : null}

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            <Plus />
            Install
          </button>
        </div>
      </form>
    </div>
  );
}

function HomeView({
  skills,
  profiles,
  updates,
  upstreams,
  permissions,
  onBrowseSkills,
  onNavigate
}: {
  skills: SkillSummary[];
  profiles: ProfilesResult | null;
  updates: UpdatesPayload | null;
  upstreams: UpstreamsResult | null;
  permissions: PermissionsResult | null;
  onBrowseSkills: () => void;
  onNavigate: (view: View) => void;
}) {
  const syncUpdates = updates?.sync.resources.length ?? 0;
  const sourceAttention =
    (updates?.updates.drifted.length ?? 0) +
    (updates?.updates.errors.length ?? 0);
  const updateReviewCount = syncUpdates + sourceAttention;
  const uncheckedSources = updates?.updates.unchecked.length ?? 0;
  const activeUpstreams = upstreams?.upstreams.filter((upstream) => upstream.enrollment.status === "active").length ?? 0;
  const revokedUpstreams = upstreams?.upstreams.filter((upstream) => upstream.enrollment.status === "revoked").length ?? 0;
  const featuredSkills = skills.slice(0, 4);
  const profileCount = profiles?.profiles.length ?? 0;
  const roleCount = permissions?.roles.length ?? 0;
  const attentionCount = updateReviewCount + revokedUpstreams;

  return (
    <div className="home-stack">
      <section className="panel home-hero av-state-scan">
        <div>
          <span className="micro-label">vault overview</span>
          <h3>{attentionCount === 0 ? "Vault steady" : `${attentionCount} item${attentionCount === 1 ? "" : "s"} need review`}</h3>
          <p>Inspect local skills, profile membership, upstream updates, and enrolled clients from one signed control surface.</p>
        </div>
        <div className="home-mark" aria-hidden="true">
          <VaultMark />
        </div>
      </section>

      <section className="home-grid" aria-label="Control plane summary">
        <HomeMetric label="Skills" value={skills.length} detail={`${countAssignedSkills(skills)} assigned`} />
        <HomeMetric label="Updates" value={updateReviewCount} detail={`${syncUpdates} signed, ${uncheckedSources} unchecked`} tone={updateReviewCount > 0 ? "warn" : "good"} />
        <HomeMetric label="Profiles" value={profileCount} detail={`${roleCount} roles visible`} />
        <HomeMetric label="Upstreams" value={activeUpstreams} detail={`${revokedUpstreams} revoked`} tone={revokedUpstreams > 0 ? "bad" : "good"} />
      </section>

      <section className="home-columns">
        <div className="panel home-actions">
          <div className="panel-header">
            <div>
              <span className="micro-label">quick routes</span>
              <h3>Start here</h3>
            </div>
          </div>
          <div className="action-grid">
            <button className="home-action av-state-admit" onClick={onBrowseSkills}>
              <FileText />
              <span>
                <strong>Browse skills</strong>
                <small>Grid, list, sort, and filters</small>
              </span>
            </button>
            <button className="home-action" onClick={() => onNavigate("updates")}>
              <RefreshCw />
              <span>
                <strong>Review updates</strong>
                <small>Signed upstream releases</small>
              </span>
            </button>
            <button className="home-action" onClick={() => onNavigate("profiles")}>
              <Users />
              <span>
                <strong>Edit profiles</strong>
                <small>Agent and tag membership</small>
              </span>
            </button>
            <button className="home-action" onClick={() => onNavigate("permissions")}>
              <ShieldCheck />
              <span>
                <strong>Audit clients</strong>
                <small>Roles, groups, enrollment</small>
              </span>
            </button>
            <button className="home-action" onClick={() => onNavigate("users")}>
              <Users />
              <span>
                <strong>Manage users</strong>
                <small>Cloud members and invites</small>
              </span>
            </button>
          </div>
        </div>

        <div className="panel home-recent">
          <div className="panel-header">
            <div>
              <span className="micro-label">skills snapshot</span>
              <h3>Installed capabilities</h3>
            </div>
          </div>
          <div className="recent-list">
            {featuredSkills.length === 0 ? <div className="empty-state">No skills installed</div> : null}
            {featuredSkills.map((skill) => (
              <div className="recent-row" key={skill.name}>
                <div>
                  <strong>{skill.title || skill.name}</strong>
                  <span>{skill.agents.join(", ") || "unassigned"}</span>
                </div>
                <span className="status-pill user-approve">{skill.version}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function HomeMetric({
  label,
  value,
  detail,
  tone = "neutral"
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return (
    <div className={`panel home-metric ${tone}`}>
      <span className="micro-label">{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

function SkillsCollection({
  skills,
  totalSkills,
  query,
  filterKey,
  sortKey,
  viewMode,
  onQueryChange,
  onFilterChange,
  onSortChange,
  onViewModeChange,
  onOpenSkill
}: {
  skills: SkillSummary[];
  totalSkills: number;
  query: string;
  filterKey: SkillFilterKey;
  sortKey: SkillSortKey;
  viewMode: SkillViewMode;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: SkillFilterKey) => void;
  onSortChange: (sort: SkillSortKey) => void;
  onViewModeChange: (mode: SkillViewMode) => void;
  onOpenSkill: (name: string) => void;
}) {
  return (
    <div className="collection-stack">
      <div className="panel collection-toolbar">
        <div>
          <span className="micro-label">skill vault</span>
          <h3>{skills.length} of {totalSkills} skills</h3>
        </div>
        <div className="collection-controls">
          <label className="search-control">
            <Search />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search skills"
              aria-label="Search skills"
            />
          </label>
          <label className="select-control">
            <SlidersHorizontal />
            <select
              value={filterKey}
              onChange={(event) => onFilterChange(event.target.value as SkillFilterKey)}
              aria-label="Filter skills"
            >
              <option value="all">All skills</option>
              <option value="network">Network</option>
              <option value="filesystem">Filesystem</option>
              <option value="actions">Actions</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
          <label className="select-control">
            <span className="micro-symbol">AZ</span>
            <select
              value={sortKey}
              onChange={(event) => onSortChange(event.target.value as SkillSortKey)}
              aria-label="Sort skills"
            >
              <option value="name">Name</option>
              <option value="agent">Agent</option>
              <option value="version">Version</option>
              <option value="resources">Resources</option>
            </select>
          </label>
          <div className="view-toggle" aria-label="Skill view mode">
            <button
              className={viewMode === "grid" ? "active" : ""}
              onClick={() => onViewModeChange("grid")}
              aria-label="Grid view"
              title="Grid view"
            >
              <Grid3X3 />
            </button>
            <button
              className={viewMode === "list" ? "active" : ""}
              onClick={() => onViewModeChange("list")}
              aria-label="List view"
              title="List view"
            >
              <List />
            </button>
          </div>
        </div>
      </div>

      {skills.length === 0 ? (
        <div className="empty-state">No skills match the current filters</div>
      ) : viewMode === "grid" ? (
        <div className="skill-card-grid">
          {skills.map((skill) => (
            <button className="skill-card" key={skill.name} onClick={() => onOpenSkill(skill.name)}>
              <div className="skill-card-top">
                <span className="status-pill active">{skill.version}</span>
                <span className="status-pill user-approve">{capabilityLabel(skill)}</span>
              </div>
              <strong>{skill.title || skill.name}</strong>
              <p>{skill.description}</p>
              <div className="skill-card-meta">
                <span>{skill.agents.join(", ") || "unassigned"}</span>
                <span>{skill.resource_count} files</span>
                <span>{skill.actions.length} actions</span>
              </div>
              <div className="chips compact">
                {skill.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="panel skill-table" role="table" aria-label="Installed skills">
          <div className="skill-table-row header" role="row">
            <span>Name</span>
            <span>Agents</span>
            <span>Version</span>
            <span>Files</span>
            <span>Capability</span>
          </div>
          {skills.map((skill) => (
            <button className="skill-table-row" key={skill.name} onClick={() => onOpenSkill(skill.name)} role="row">
              <span>{skill.title || skill.name}</span>
              <span>{skill.agents.join(", ") || "unassigned"}</span>
              <span>{skill.version}</span>
              <span>{skill.resource_count}</span>
              <span>{capabilityLabel(skill)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VaultMark() {
  return (
    <div className="brand-mark av-state-locked" aria-hidden="false">
      <svg viewBox="0 0 24 24" fill="none" role="img" aria-labelledby="av-brand-title av-brand-desc">
        <title id="av-brand-title">AutoVault mark</title>
        <desc id="av-brand-desc">Rounded mint vault with bottom stubs and a center dial.</desc>
        <rect x="2.4" y="2.4" width="19.2" height="16.8" rx="3.84" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M7.2 19.2v1.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M16.8 19.2v1.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle className="av-dial-lock" cx="12" cy="10.8" r="2.9" stroke="currentColor" strokeWidth="1.25" />
        <path className="av-dial-lock" d="M12 7.9v1.45" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function SkillEditor({
  detail,
  busy,
  onBack,
  onSave,
  onDelete,
  onUpdate
}: {
  detail: SkillDetail;
  busy: boolean;
  onBack: () => void;
  onSave: (name: string, payload: unknown) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onUpdate: (name: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<SkillDetailTab>("files");
  const [description, setDescription] = useState(detail.description);
  const [agents, setAgents] = useState(detail.agents.join(", "));
  const [tags, setTags] = useState(detail.tags.join(", "));
  const [version, setVersion] = useState(detail.version);
  const [title, setTitle] = useState(detail.title ?? "");
  const [category, setCategory] = useState(detail.category ?? "");

  function submit(event: FormEvent): void {
    event.preventDefault();
    void onSave(detail.name, {
      title: title.trim() || null,
      description,
      agents: splitCsv(agents),
      tags: splitCsv(tags),
      category: category.trim() || null,
      metadata: { version: version.trim() || detail.version }
    });
  }

  return (
    <div className="skill-detail-stack">
      <section className="panel skill-detail-head av-state-admit">
        <div className="panel-header">
          <div>
            <span className="micro-label">skill package</span>
            <h3>{detail.title || detail.name}</h3>
            <p>{detail.description}</p>
          </div>
          <div className="button-row">
            <button type="button" className="icon-button" onClick={onBack} disabled={busy}>
              <ArrowLeft />
              All skills
            </button>
            <button type="button" className="icon-button" onClick={() => void onUpdate(detail.name)} disabled={busy}>
              <RefreshCw />
              Update
            </button>
          </div>
        </div>
        <div className="skill-detail-tabs" role="tablist" aria-label="Skill detail sections">
          <DetailTab active={tab === "files"} onClick={() => setTab("files")}>Files</DetailTab>
          <DetailTab active={tab === "overview"} onClick={() => setTab("overview")}>Overview</DetailTab>
          <DetailTab active={tab === "permissions"} onClick={() => setTab("permissions")}>Permissions</DetailTab>
          <DetailTab active={tab === "provenance"} onClick={() => setTab("provenance")}>Provenance</DetailTab>
          <DetailTab active={tab === "edit"} onClick={() => setTab("edit")}>Edit</DetailTab>
        </div>
      </section>

      <div className="content-grid">
        {tab === "files" ? (
          <SkillBundleInspector detail={detail} />
        ) : tab === "overview" ? (
          <SkillOverview detail={detail} />
        ) : tab === "permissions" ? (
          <PermissionSurface detail={detail} />
        ) : tab === "provenance" ? (
          <SkillProvenancePanel detail={detail} />
        ) : (
          <form className="panel editor manifest-editor" onSubmit={submit}>
            <div className="panel-header">
              <div>
                <span className="micro-label">frontmatter</span>
                <h3>Edit metadata</h3>
                <p>Focused writes rebuild SKILL.md through AutoVault validation.</p>
              </div>
              <button type="submit" className="primary-button" disabled={busy}>
                <Save />
                Save
              </button>
            </div>

            <label>
              Title
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              Description
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} />
            </label>
            <div className="two-col">
              <label>
                Agents
                <input value={agents} onChange={(event) => setAgents(event.target.value)} />
              </label>
              <label>
                Tags
                <input value={tags} onChange={(event) => setTags(event.target.value)} />
              </label>
            </div>
            <div className="two-col">
              <label>
                Version
                <input value={version} onChange={(event) => setVersion(event.target.value)} />
              </label>
              <label>
                Category
                <input value={category} onChange={(event) => setCategory(event.target.value)} />
              </label>
            </div>
          </form>
        )}

        <SkillFacts detail={detail} busy={busy} onDelete={onDelete} />
      </div>
    </div>
  );
}

function DetailTab({
  active,
  children,
  onClick
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={active ? "active" : ""} role="tab" aria-selected={active} onClick={onClick}>
      {children}
    </button>
  );
}

function SkillBundleInspector({ detail }: { detail: SkillDetail }) {
  const [selectedPath, setSelectedPath] = useState(detail.bundle.files[0]?.path ?? detail.bundle.root);
  const selected = detail.bundle.files.find((file) => file.path === selectedPath) ?? detail.bundle.files[0];
  return (
    <section className="panel bundle-browser">
      <div className="panel-header">
        <div>
          <span className="micro-label">Bundle contents</span>
          <h3>{detail.bundle.files.length} files</h3>
          <p>Every declared file is inspectable here. Scripts and action files are previewed as text only.</p>
        </div>
        <span className="status-pill active">{detail.bundle.root}</span>
      </div>

      <div className="bundle-layout">
        <nav className="resource-tree" aria-label="Skill bundle files">
          {detail.bundle.files.map((file) => (
            <button
              key={file.path}
              className={selected?.path === file.path ? "active" : ""}
              onClick={() => setSelectedPath(file.path)}
            >
              <span className="kind">{file.kind}</span>
              <span>
                <strong>{file.title}</strong>
                <small>{file.path}</small>
              </span>
            </button>
          ))}
        </nav>

        {selected ? (
          <article className="resource-preview">
            <div className="resource-preview-head">
              <div>
                <span className="micro-label">{selected.group}</span>
                <h3>{selected.path}</h3>
              </div>
              <span className="status-pill user-approve">{selected.kind}</span>
            </div>
            <p>{selected.summary}</p>
            {selected.preview_status === "loaded" ? (
              selected.kind === "svg" ? (
                <div className="svg-preview" dangerouslySetInnerHTML={{ __html: selected.preview ?? "" }} />
              ) : (
                <pre>{selected.preview}</pre>
              )
            ) : (
              <div className="empty-state">Preview unavailable for this resource</div>
            )}
          </article>
        ) : null}
      </div>
    </section>
  );
}

function SkillOverview({ detail }: { detail: SkillDetail }) {
  const body = detail.skill_md.split("---").slice(2).join("---").trim() || detail.skill_md;
  return (
    <section className="panel skill-overview-panel">
      <span className="micro-label">overview</span>
      <h3>{detail.name}</h3>
      <p>{detail.description}</p>
      <div className="overview-grid">
        <OverviewItem label="Version" value={detail.version} />
        <OverviewItem label="Category" value={detail.category ?? "uncategorized"} />
        <OverviewItem label="Agents" value={detail.agents.join(", ") || "unassigned"} />
        <OverviewItem label="Tags" value={detail.tags.join(", ") || "none"} />
      </div>
      <pre className="skill-md-preview">{body}</pre>
    </section>
  );
}

function OverviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PermissionSurface({ detail }: { detail: SkillDetail }) {
  return (
    <section className="panel permission-surface">
      <span className="micro-label">Permission surface</span>
      <h3>Declared capability requirements</h3>
      <div className="permission-grid">
        <PermissionRow label="Network" value={detail.capabilities.network ? "allowed" : "not declared"} tone={detail.capabilities.network ? "warn" : "good"} />
        <PermissionRow label="Filesystem" value={detail.capabilities.filesystem} tone={detail.capabilities.filesystem === "readwrite" ? "warn" : "good"} />
        <PermissionRow label="Tools" value={detail.capabilities.tools.join(", ") || "none"} />
        <PermissionRow label="Actions" value={detail.actions.join(", ") || "none"} />
      </div>
    </section>
  );
}

function PermissionRow({
  label,
  value,
  tone = "neutral"
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn";
}) {
  return (
    <div className={`permission-row ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SkillProvenancePanel({ detail }: { detail: SkillDetail }) {
  const source = detail.provenance.source;
  return (
    <section className="panel provenance-panel">
      <span className="micro-label">Provenance</span>
      <h3>Source and integrity</h3>
      <div className="provenance-grid">
        <OverviewItem label="Integrity" value={detail.provenance.integrity} />
        <OverviewItem label="Source" value={source.label} />
        <OverviewItem label="Status" value={source.status} />
        <OverviewItem label="Identifier" value={source.identifier ?? "not recorded"} />
        <OverviewItem label="Fetched" value={source.fetched_at ?? "not recorded"} />
        <OverviewItem label="Content hash" value={source.content_hash ? shortHash(source.content_hash) : "not recorded"} />
      </div>
      {source.reason ? <div className="notice error"><AlertTriangle /><span>{source.reason}</span></div> : null}
    </section>
  );
}

function SkillFacts({
  detail,
  busy,
  onDelete
}: {
  detail: SkillDetail;
  busy: boolean;
  onDelete: (name: string) => Promise<void>;
}) {
  return (
    <aside className="panel facts manifest-panel av-state-admit">
      <div className="manifest-heading">
        <span className="micro-label">manifest</span>
        <strong>{detail.version}</strong>
      </div>
      <div className="manifest-block">
        <span>write path</span>
        <strong>validated</strong>
      </div>
      <div className="fact-row">
        <Tags />
        <div>
          <strong>{detail.tags.length || 0}</strong>
          <span>tags</span>
        </div>
      </div>
      <div className="fact-row">
        <Users />
        <div>
          <strong>{detail.agents.length || 0}</strong>
          <span>agents</span>
        </div>
      </div>
      <div className="fact-row">
        <Wrench />
        <div>
          <strong>{detail.actions.length || 0}</strong>
          <span>actions</span>
        </div>
      </div>
      <div className="fact-row">
        <FileText />
        <div>
          <strong>{detail.bundle.files.length || 0}</strong>
          <span>bundle files</span>
        </div>
      </div>
      <div className="chips">
        {detail.agents.map((agent) => <span key={agent}>{agent}</span>)}
        {detail.tags.map((tag) => <span key={tag}>{tag}</span>)}
      </div>
      <button className="danger-button" onClick={() => void onDelete(detail.name)} disabled={busy}>
        <Trash2 />
        Delete
      </button>
    </aside>
  );
}

type EditableProfile = {
  name: string;
  agent: string;
  target: string;
  includeTags: string;
  excludeTags: string;
  exportSkillOverrides: boolean | string;
  skills: string[];
};

function ProfileEditor({
  profiles,
  busy,
  onSave,
  onSync
}: {
  profiles: ProfilesResult | null;
  busy: boolean;
  onSave: (profiles: EditableProfile[]) => Promise<void>;
  onSync: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<EditableProfile[]>(
    () => profiles?.profiles.map(profileToDraft) ?? []
  );

  function update(index: number, patch: Partial<EditableProfile>): void {
    setDrafts((current) =>
      current.map((profile, currentIndex) =>
        currentIndex === index ? { ...profile, ...patch } : profile
      )
    );
  }

  return (
      <div className="panel profile-panel">
        <div className="panel-header">
          <div>
            <span className="micro-label">membership routing</span>
            <h3>Named profiles</h3>
            <p>{profiles?.configPath ?? "profiles.config.json"}</p>
          </div>
        <div className="button-row">
          <button
            className="icon-button"
            onClick={() => setDrafts((current) => [...current, blankProfile()])}
            disabled={busy}
          >
            <Plus />
            Add
          </button>
          <button className="icon-button" onClick={() => void onSync()} disabled={busy}>
            <RefreshCw />
            Sync
          </button>
          <button className="primary-button" onClick={() => void onSave(drafts)} disabled={busy}>
            <Save />
            Save
          </button>
        </div>
      </div>

      <div className="profile-list">
        {drafts.length === 0 ? <div className="empty-state">No named profiles configured</div> : null}
        {drafts.map((profile, index) => (
          <div className="profile-row" key={`${profile.name}:${index}`}>
            <div className="profile-fields">
              <label>
                Name
                <input value={profile.name} onChange={(event) => update(index, { name: event.target.value })} />
              </label>
              <label>
                Agent
                <input value={profile.agent} onChange={(event) => update(index, { agent: event.target.value })} />
              </label>
              <label className="target-field">
                Target
                <input value={profile.target} onChange={(event) => update(index, { target: event.target.value })} />
              </label>
              <label>
                Include
                <input
                  value={profile.includeTags}
                  onChange={(event) => update(index, { includeTags: event.target.value })}
                />
              </label>
              <label>
                Exclude
                <input
                  value={profile.excludeTags}
                  onChange={(event) => update(index, { excludeTags: event.target.value })}
                />
              </label>
            </div>
            <div className="profile-meta">
              <div className="chips compact">
                {profile.skills.length === 0
                  ? <span>0 skills</span>
                  : profile.skills.map((skill) => <span key={skill}>{skill}</span>)}
              </div>
              <button
                className="ghost-button"
                onClick={() => setDrafts((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                disabled={busy}
              >
                <X />
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UpdatesPanel({
  updates,
  onRefresh,
  onInstall,
  busy
}: {
  updates: UpdatesPayload | null;
  onRefresh: () => Promise<void>;
  onInstall: (resource: SyncUpdateResource) => Promise<void>;
  busy: boolean;
}) {
  const sourceUpdates = updates?.updates;
  const syncUpdates = updates?.sync;
  const items = [
    ...(sourceUpdates?.drifted.map((entry) => ({ kind: "Drift", name: entry.name, text: entry.reason })) ?? []),
    ...(sourceUpdates?.unchecked.map((entry) => ({ kind: "Unchecked", name: entry.name, text: entry.reason })) ?? []),
    ...(sourceUpdates?.errors.map((entry) => ({ kind: "Error", name: entry.name, text: entry.error })) ?? []),
    ...(sourceUpdates?.warnings.map((entry) => ({ kind: "Warning", name: entry.name, text: entry.warning })) ?? [])
  ];
  const syncResources = syncUpdates?.resources ?? [];
  const syncErrors = syncUpdates?.errors ?? [];
  const hasUpdates = syncResources.length > 0 || items.length > 0 || syncErrors.length > 0;
  return (
    <div className="panel updates-panel">
      <div className="panel-header">
        <div>
          <span className="micro-label">signed upstreams</span>
          <h3>Update checks</h3>
          <p>{syncResources.length} upstream available, {sourceUpdates?.up_to_date.length ?? 0} source current</p>
        </div>
        <button className="icon-button" onClick={() => void onRefresh()} disabled={busy}>
          <RefreshCw />
          Check
        </button>
      </div>

      {!hasUpdates ? (
        <div className="notice success">
          <CheckCircle2 />
          <span>No updates available</span>
        </div>
      ) : null}

      {syncResources.length > 0 ? (
        <div className="sync-list">
          {syncResources.map((resource) => (
            <div
              className={`sync-row av-state-scan ${resource.installable ? "av-state-admit" : "av-state-held"}`}
              key={`${resource.upstream_id}:${resource.id}`}
            >
              <div className="sync-main">
                <div className="sync-title">
                  <strong>{resource.name}</strong>
                  <span className={`status-pill ${resource.policy.replace("_", "-")}`}>
                    {policyLabel(resource.policy)}
                  </span>
                  {resource.breaking ? <span className="status-pill warning">Breaking</span> : null}
                </div>
                <p>{resource.changelog || "No changelog provided"}</p>
                <div className="sync-meta">
                  <span>{resource.upstream_name}</span>
                  <span>{resource.installed_version ?? "not installed"}{" -> "}{resource.available_version}</span>
                  <span>{resource.channel}</span>
                  <span>{resource.signature.algorithm}</span>
                  <span>{shortHash(resource.bundle_hash)}</span>
                </div>
              </div>
              <button
                className={resource.installable ? "primary-button admit-button" : "icon-button"}
                onClick={() => void onInstall(resource)}
                disabled={busy || !resource.installable}
              >
                <RefreshCw />
                {resource.installable ? "Install" : "Held"}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {syncErrors.length > 0 ? (
        <div className="status-list">
          {syncErrors.map((item) => (
            <div className="status-row" key={`sync:${item.upstream_id}:${item.error}`}>
              <span className="status-pill error">Sync</span>
              <strong>{item.upstream_id}</strong>
              <span>{item.error}</span>
            </div>
          ))}
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="status-list">
          {items.map((item) => (
            <div className="status-row" key={`${item.kind}:${item.name}:${item.text}`}>
              <span className={`status-pill ${item.kind.toLowerCase()}`}>{item.kind}</span>
              <strong>{item.name}</strong>
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PermissionsPanel({
  permissions,
  upstreams,
  busy,
  onRevoke
}: {
  permissions: PermissionsResult | null;
  upstreams: UpstreamsResult | null;
  busy: boolean;
  onRevoke: (upstream: EnrolledUpstream) => Promise<void>;
}) {
  return (
    <div className="permissions-stack">
      <div className="panel">
        <div className="panel-header">
          <div>
            <span className="micro-label">visibility rules</span>
            <h3>Permission groups</h3>
            <p>{permissions?.mode ?? "local"} mode</p>
          </div>
          <div className="role-strip">
            {permissions?.roles.map((role) => <span key={role}>{role}</span>)}
          </div>
        </div>
        <div className="group-grid">
          {permissions?.capability_groups.length ? permissions.capability_groups.map((group) => (
            <div className="group-row" key={group.name}>
              <strong>{group.name}</strong>
              <span>{group.description || "No description"}</span>
              <div className="chips compact">
                {group.tags.map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            </div>
          )) : <div className="empty-state">No capability groups configured</div>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <span className="micro-label">enrollment state</span>
            <h3>Authorized clients</h3>
            <p>{upstreams?.upstreams.length ?? 0} enrolled upstreams</p>
          </div>
        </div>
        <div className="client-list">
          {upstreams?.upstreams.length ? upstreams.upstreams.map((upstream) => (
            <div
              className={`client-row ${upstream.enrollment.status === "revoked" ? "av-state-rejected" : "av-state-admit"}`}
              key={upstream.id}
            >
              <div>
                <strong>{upstream.name}</strong>
                <span>{upstream.id}</span>
              </div>
              <div className="client-meta">
                <span className={`status-pill ${upstream.enrollment.status}`}>
                  {upstream.enrollment.status}
                </span>
                <span>{upstream.enrollment.device_id}</span>
                <span>{upstream.enrollment.last_check_in_at ?? "never checked in"}</span>
              </div>
              <button
                className="danger-button"
                onClick={() => void onRevoke(upstream)}
                disabled={busy || upstream.enrollment.status === "revoked"}
              >
                <Trash2 />
                Revoke
              </button>
            </div>
          )) : <div className="empty-state">No upstream clients enrolled</div>}
        </div>
      </div>
    </div>
  );
}

function UsersPanel({
  permissions,
  upstreams
}: {
  permissions: PermissionsResult | null;
  upstreams: UpstreamsResult | null;
}) {
  const canManageUsers = permissions?.abilities?.can_manage_users ?? false;
  const activeDevices = upstreams?.upstreams.filter((upstream) => upstream.enrollment.status === "active").length ?? 0;
  return (
    <div className="users-panel">
      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="micro-label">team access</span>
            <h3>Users and invites</h3>
            <p>{canManageUsers ? "Manage cloud vault members, roles, and invites." : "Local vaults run as a single operator."}</p>
          </div>
          <button className="primary-button" disabled={!canManageUsers}>
            <Plus />
            Invite user
          </button>
        </div>

        {canManageUsers ? (
          <div className="empty-state">Cloud members will appear here when the cloud adapter is connected</div>
        ) : (
          <div className="local-user-state av-state-held">
            <div className="account-card large">
              <span className="status-dot" />
              <span>
                <strong>Local operator</strong>
                <small>Loopback session · owner</small>
              </span>
            </div>
            <p>Invites, member roles, and team assignments are cloud controls. Local mode keeps the same route and layout so the hosted dashboard can use this page without a separate product fork.</p>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="micro-label">client devices</span>
            <h3>Enrolled clients</h3>
            <p>{activeDevices} active upstream client{activeDevices === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div className="client-list">
          {upstreams?.upstreams.length ? upstreams.upstreams.map((upstream) => (
            <div className="client-row" key={upstream.id}>
              <div>
                <strong>{upstream.name}</strong>
                <span>{upstream.id}</span>
              </div>
              <div className="client-meta">
                <span className={`status-pill ${upstream.enrollment.status}`}>
                  {upstream.enrollment.status}
                </span>
                <span>{upstream.enrollment.device_id}</span>
                <span>{upstream.enrollment.last_check_in_at ?? "never checked in"}</span>
              </div>
            </div>
          )) : <div className="empty-state">No client devices enrolled</div>}
        </div>
      </section>
    </div>
  );
}

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      message = await response.text();
    }
    throw new ApiRequestError(response.status, message);
  }
  return await response.json() as T;
}

function upgradeRequiredContext(reason: string): DashboardContext {
  return {
    mode: "local",
    api_version: "0.0.0",
    ui_bundle_version: "remote",
    ui_channel: "stable",
    ui_delivery: {
      source: "unknown",
      fallback_reason: reason
    },
    abilities: {
      can_add_skill: false,
      can_manage_users: false,
      can_invite_users: false,
      can_manage_billing: false,
      can_install_local: false,
      can_manage_upstreams: false
    },
    account: {
      mode: "local",
      label: "Local operator",
      provider: "loopback session"
    },
    vault: {
      mode: "local",
      storage_path: ""
    },
    compatibility: {
      status: "upgrade_required",
      api_version: "0.0.0",
      min_api_version: "1.0.0",
      reason
    }
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function profileToDraft(profile: ProfileMembership): EditableProfile {
  return {
    name: profile.name,
    agent: profile.agent,
    target: profile.target,
    includeTags: profile.include_tags === "*" ? "*" : profile.include_tags.join(", "),
    excludeTags: profile.exclude_tags.join(", "),
    exportSkillOverrides: profile.export_skill_overrides ?? false,
    skills: profile.skills
  };
}

function blankProfile(): EditableProfile {
  return {
    name: "new-profile",
    agent: "codex",
    target: "",
    includeTags: "*",
    excludeTags: "",
    exportSkillOverrides: false,
    skills: []
  };
}

function headingFor(view: View, detail: SkillDetail | null): string {
  if (view === "home") return "Control Plane";
  if (view === "skills") return detail?.title || detail?.name || "Skills";
  if (view === "profiles") return "Profiles";
  if (view === "updates") return "Updates";
  if (view === "permissions") return "Permissions";
  return "Users";
}

function countAssignedSkills(skills: SkillSummary[]): number {
  return skills.filter((skill) => skill.agents.length > 0).length;
}

function compareSkills(left: SkillSummary, right: SkillSummary, sortKey: SkillSortKey): number {
  if (sortKey === "agent") return firstAgent(left).localeCompare(firstAgent(right)) || left.name.localeCompare(right.name);
  if (sortKey === "version") return left.version.localeCompare(right.version) || left.name.localeCompare(right.name);
  if (sortKey === "resources") return right.resource_count - left.resource_count || left.name.localeCompare(right.name);
  return (left.title || left.name).localeCompare(right.title || right.name);
}

function skillMatchesFilter(skill: SkillSummary, filterKey: SkillFilterKey): boolean {
  if (filterKey === "network") return skill.capabilities.network;
  if (filterKey === "filesystem") return skill.capabilities.filesystem === "readwrite";
  if (filterKey === "actions") return skill.actions.length > 0;
  if (filterKey === "unassigned") return skill.agents.length === 0;
  return true;
}

function capabilityLabel(skill: SkillSummary): string {
  if (skill.capabilities.network) return "network";
  if (skill.capabilities.filesystem === "readwrite") return "write";
  if (skill.actions.length > 0) return "actions";
  return "read";
}

function firstAgent(skill: SkillSummary): string {
  return skill.agents[0] ?? "unassigned";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function policyLabel(policy: SyncUpdatePolicy): string {
  if (policy === "auto_apply") return "Auto";
  if (policy === "user_approve") return "Review";
  return "Held";
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}...` : hash;
}
