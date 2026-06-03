import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Grid3X3,
  Home,
  Loader2,
  List,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
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

// The result of an add-skill attempt, surfaced inside the dialog so the
// operator sees the outcome in context instead of behind the modal backdrop.
// `installed` carries any non-blocking warnings (auto-normalized frontmatter,
// non-strict security advisories, post-install profile-sync notes); `failed`
// carries the actionable reason (validation errors, fetch failures).
type InstallOutcome =
  | { status: "installed"; name: string; warnings: string[] }
  | { status: "failed"; message: string };

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

  async function createSkill(payload: AddSkillPayload): Promise<InstallOutcome> {
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ skill: SkillDetail; result: { warnings?: unknown } }>("/skills", {
        method: "POST",
        body: payload
      });
      const warnings = Array.isArray(body.result?.warnings)
        ? body.result.warnings.filter((warning): warning is string => typeof warning === "string")
        : [];
      // The 201 means the skill is committed and signed. Surface it
      // immediately, then refresh in the background — a follow-up refresh
      // rejection must not be reported as an install failure.
      setSelectedName(body.skill.name);
      setDetail(body.skill);
      setView("skills");
      void Promise.all([refreshSkills(body.skill.name), refreshProfiles(), refreshUpdates()]).catch(
        () => {
          /* background refresh; the install already succeeded */
        }
      );
      return { status: "installed", name: body.skill.name, warnings };
    } catch (createError) {
      return { status: "failed", message: errorMessage(createError) };
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
  onCreate: (payload: AddSkillPayload) => Promise<InstallOutcome>;
}) {
  const [source, setSource] = useState<AddSkillPayload["source"]>("inline");
  const [identifier, setIdentifier] = useState("");
  const [skillMd, setSkillMd] = useState("");
  const [skillDir, setSkillDir] = useState("");
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);

  // The dialog stays mounted (renders null when closed), so clear any prior
  // outcome each time it reopens.
  useEffect(() => {
    if (open) setOutcome(null);
  }, [open]);

  if (!open) return null;

  function buildPayload(): AddSkillPayload {
    if (source === "inline") {
      return { source, identifier: identifier.trim() || undefined, skill_md: skillMd };
    }
    if (source === "local") {
      return { source, identifier: identifier.trim() || undefined, skill_dir: skillDir.trim() };
    }
    return { source, identifier: identifier.trim() };
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setOutcome(null);
    const payload = buildPayload();
    // The inputs use `required`, which treats whitespace as valid, but
    // buildPayload trims — so a blank-but-spaces entry would round-trip to a
    // confusing server failure. Guard the trimmed required fields here.
    const guardMessage =
      payload.source === "local"
        ? payload.skill_dir
          ? null
          : "Enter the skill folder path to install from."
        : payload.source !== "inline" && !payload.identifier
          ? "Enter a repo/path, URL, or upstream id."
          : null;
    if (guardMessage) {
      setOutcome({ status: "failed", message: guardMessage });
      return;
    }
    const result = await onCreate(payload);
    // Clean install: close and let the parent's navigation reveal the skill.
    // Installed-with-warnings or failure: keep the dialog open and report
    // in context (form state is preserved for a retry on failure).
    if (result.status === "installed" && result.warnings.length === 0) {
      onClose();
      return;
    }
    setOutcome(result);
  }

  const installed = outcome?.status === "installed" ? outcome : null;

  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="panel add-skill-dialog" onSubmit={(event) => void submit(event)}>
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
            onChange={(event) => {
              setOutcome(null);
              setSource(event.target.value as AddSkillPayload["source"]);
            }}
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
              onChange={(event) => {
                setOutcome(null);
                setSkillDir(event.target.value);
              }}
              placeholder="/path/to/skill"
              required
            />
          </label>
        ) : (
          <label>
            Identifier
            <input
              value={identifier}
              onChange={(event) => {
                setOutcome(null);
                setIdentifier(event.target.value);
              }}
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
              onChange={(event) => {
                setOutcome(null);
                setSkillMd(event.target.value);
              }}
              placeholder={"---\nname: my-skill\ndescription: ...\n---\n\n# my-skill"}
              rows={12}
              required
            />
          </label>
        ) : null}

        {outcome?.status === "failed" ? (
          <div className="notice error" role="alert">
            <AlertTriangle />
            <div className="dialog-outcome">
              <strong>Install failed</strong>
              <span>{outcome.message}</span>
            </div>
          </div>
        ) : null}

        {installed ? (
          <div className="notice success" role="status">
            <CheckCircle2 />
            <div className="dialog-outcome">
              <strong>Installed {installed.name} with {installed.warnings.length} note{installed.warnings.length === 1 ? "" : "s"}</strong>
              {installed.warnings.map((warning, index) => (
                <span key={index}>{warning}</span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="dialog-actions">
          {installed ? (
            <button type="button" className="primary-button" onClick={onClose}>
              View skill
            </button>
          ) : (
            <>
              <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={busy}>
                {busy ? <Loader2 className="spin" /> : <Plus />}
                Install
              </button>
            </>
          )}
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
      <section className="panel home-hero">
        <div>
          <span className="micro-label">vault overview</span>
          <h3>
            {attentionCount === 0 ? (
              <>Vault <span className="serif-accent">steady</span></>
            ) : (
              <>
                {attentionCount} item{attentionCount === 1 ? "" : "s"} need{" "}
                <span className="serif-accent">review</span>
              </>
            )}
          </h3>
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
    <div className="dir-page">
      <div className="dir-toolbar">
        <div className="dir-count">
          <strong>{skills.length}</strong> of {totalSkills} skills
        </div>
        <div className="dir-controls">
          <label className="dir-search">
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
        <div className="dir-grid">
          {skills.map((skill) => {
            const orgText = skill.title && skill.title !== skill.name ? skill.name : skill.category ?? "";
            return (
              <button className="skill-tile" key={skill.name} onClick={() => onOpenSkill(skill.name)}>
                <div className="stl-head">
                  <span className="stl-icon">{skillInitials(skill.title || skill.name)}</span>
                  <span className="stl-name">
                    <span className="name">{skill.title || skill.name}</span>
                    {orgText ? <span className="org">{orgText}</span> : null}
                  </span>
                  <span className="stl-badges">
                    <span className="cap-pill ver">v{skill.version}</span>
                    <CapabilityPill skill={skill} />
                  </span>
                </div>
                <p className="stl-desc">{skill.description}</p>
                <div className="stl-agents">
                  {skill.agents.length === 0 ? (
                    <span className="ag">unassigned</span>
                  ) : (
                    skill.agents.slice(0, 5).map((agent) => <span className="ag" key={agent}>{agent}</span>)
                  )}
                </div>
                <div className="stl-meta">
                  <span>{skill.resource_count} files</span>
                  <span>{skill.actions.length} actions</span>
                  <span>{skill.tags.length} tags</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="dir-list" role="table" aria-label="Installed skills">
          <div className="dir-list-head" role="row">
            <span>Name</span>
            <span>Description</span>
            <span>Agents</span>
            <span>Version</span>
            <span>Files</span>
          </div>
          {skills.map((skill) => (
            <button className="dir-list-item" key={skill.name} onClick={() => onOpenSkill(skill.name)} role="row">
              <span className="li-name">
                <strong>{skill.title || skill.name}</strong>
              </span>
              <span className="li-desc">{skill.description}</span>
              <span className="li-cell">{skill.agents.join(", ") || "unassigned"}</span>
              <span className="li-cell">{skill.version}</span>
              <span className="li-cell">{skill.resource_count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CapabilityPill({ skill }: { skill: SkillSummary }) {
  if (skill.capabilities.network) return <span className="cap-pill net">network</span>;
  if (skill.capabilities.filesystem === "readwrite") return <span className="cap-pill write">write</span>;
  if (skill.actions.length > 0) return <span className="cap-pill">actions</span>;
  return <span className="cap-pill read">read</span>;
}

function skillInitials(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (!cleaned) return "AV";
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
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

  const source = detail.provenance.source;
  const badge = sourceBadgeVariant(source.status);

  return (
    <div className="sd-page">
      <nav className="sd-crumb" aria-label="Breadcrumb">
        <button onClick={onBack} disabled={busy}>Skills</button>
        <span className="sep">/</span>
        <span className="cur">{detail.name}</span>
      </nav>

      <header className="sd-head">
        <div>
          <div className="ttl-row">
            <span className="icon-tile">{skillInitials(detail.title || detail.name)}</span>
            <div>
              <h1>
                {detail.title || detail.name}
                {detail.title && detail.title !== detail.name ? (
                  <span className="org"> {detail.name}</span>
                ) : null}
              </h1>
              <div className="sub-row">
                <span className="verified"><ShieldCheck /> Signed</span>
                <span className={`source-badge ${badge}`}>{source.label}</span>
                <span className="dot" />
                <span>v{detail.version}</span>
                {detail.category ? (
                  <>
                    <span className="dot" />
                    <span>{detail.category}</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
          <p className="desc">{detail.description}</p>
        </div>
        <div className="sd-actions">
          <button
            type="button"
            className="sd-installbtn"
            onClick={() => void onUpdate(detail.name)}
            disabled={busy}
          >
            <RefreshCw />
            Update from source
          </button>
          <div className="sd-secondary-actions">
            <button type="button" className="sd-sbtn" onClick={() => setTab("provenance")} disabled={busy}>
              <ShieldCheck />
              Verify
            </button>
            <button
              type="button"
              className="sd-sbtn danger"
              onClick={() => void onDelete(detail.name)}
              disabled={busy}
            >
              <Trash2 />
              Delete
            </button>
          </div>
          {source.reason ? <p className="sd-copy-status">{source.reason}</p> : null}
        </div>
      </header>

      <div className="sd-stats">
        <div className="st">
          <div className="lbl">Version</div>
          <div className="val">{detail.version}</div>
          <div className="trend muted">manifest</div>
        </div>
        <div className="st">
          <div className="lbl">Bundle files</div>
          <div className="val">{detail.bundle.files.length}</div>
          <div className="trend muted">signed on write</div>
        </div>
        <div className="st">
          <div className="lbl">Agents</div>
          <div className="val">{detail.agents.length}</div>
          <div className="trend muted">{detail.agents.length === 0 ? "unassigned" : "assigned"}</div>
        </div>
        <div className="st">
          <div className="lbl">Actions</div>
          <div className="val">{detail.actions.length}</div>
          <div className="trend muted">{detail.capabilities.tools.length} tools</div>
        </div>
      </div>

      <div className="sd-tabs" role="tablist" aria-label="Skill detail sections">
        <DetailTab active={tab === "files"} onClick={() => setTab("files")}>
          Files <span className="ct">{detail.bundle.files.length}</span>
        </DetailTab>
        <DetailTab active={tab === "overview"} onClick={() => setTab("overview")}>Overview</DetailTab>
        <DetailTab active={tab === "permissions"} onClick={() => setTab("permissions")}>Permissions</DetailTab>
        <DetailTab active={tab === "provenance"} onClick={() => setTab("provenance")}>Provenance</DetailTab>
        <DetailTab active={tab === "edit"} onClick={() => setTab("edit")}>Edit</DetailTab>
      </div>

      <div className="sd-body">
        <main>
          {tab === "files" ? (
            <SkillBundleInspector detail={detail} />
          ) : tab === "overview" ? (
            <div className="sd-md">
              <div className="sd-md-head">
                <span className="lights"><span /><span /><span /></span>
                <span className="filename">SKILL.md</span>
              </div>
              <div className="sd-md-body">
                <pre>{detail.skill_md}</pre>
              </div>
            </div>
          ) : tab === "permissions" ? (
            <SkillPermissionList detail={detail} />
          ) : tab === "provenance" ? (
            <SkillProvenanceTimeline detail={detail} />
          ) : (
            <form className="sd-edit" onSubmit={submit}>
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
        </main>

        <aside className="sd-rail">
          <div className="sd-card">
            <h4>Compatibility</h4>
            <div className="sd-agent-list">
              {detail.agents.length === 0 ? (
                <div className="sd-agent-row">
                  <span className="swatch" style={{ background: "var(--av-ink-4)" }} />
                  <span className="lbl">No agents assigned</span>
                  <span className="stat off">idle</span>
                </div>
              ) : (
                detail.agents.map((agent) => (
                  <div className="sd-agent-row" key={agent}>
                    <span className="swatch" style={{ background: agentSwatch(agent) }} />
                    <span className="lbl">{agent}</span>
                    <span className="stat">active</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="sd-card">
            <h4>Metadata</h4>
            <div className="kv">
              <span className="k">Version</span>
              <span className="v mono">{detail.version}</span>
              <span className="k">Category</span>
              <span className="v">{detail.category ?? "uncategorized"}</span>
              <span className="k">Files</span>
              <span className="v mono">{detail.bundle.files.length}</span>
              <span className="k">Tags</span>
              <span className="v">{detail.tags.length || "none"}</span>
              <span className="k">Integrity</span>
              <span className="v accent">{detail.provenance.integrity}</span>
            </div>
          </div>

          <div className="sd-card">
            <h4>Permissions</h4>
            <div className="sd-perm-list">
              <PermLine
                label="Network"
                state={detail.capabilities.network ? "warn" : "no"}
                scope={detail.capabilities.network ? "allowed" : "off"}
              />
              <PermLine
                label="Filesystem"
                state={detail.capabilities.filesystem === "readwrite" ? "warn" : "ok"}
                scope={detail.capabilities.filesystem}
              />
            </div>
          </div>

          <div className="sd-card">
            <h4>Source</h4>
            <div className="kv">
              <span className="k">Origin</span>
              <span className="v">{source.label}</span>
              <span className="k">Status</span>
              <span className="v">{source.status}</span>
              <span className="k">Identifier</span>
              <span className="v mono">{source.identifier ?? "not recorded"}</span>
            </div>
          </div>
        </aside>
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
    <section className="sd-bundle">
      <div className="sd-bundle-head">
        <div>
          <h2>Bundle contents</h2>
          <p>Every declared file is inspectable here. Scripts and action files are previewed as text only.</p>
        </div>
        <div className="sd-bundle-count">
          <strong>{detail.bundle.files.length}</strong>
          <span>files</span>
        </div>
      </div>

      <div className="sd-bundle-grid">
        <nav className="sd-resource-tree" aria-label="Skill bundle files">
          {detail.bundle.files.map((file) => (
            <div className={`sd-resource-row ${selected?.path === file.path ? "active" : ""}`} key={file.path}>
              <button onClick={() => setSelectedPath(file.path)}>
                <span className="kind">{file.kind}</span>
                <span className="file">
                  <span className="title">{file.title}</span>
                  <span className="path">{file.path}</span>
                </span>
              </button>
            </div>
          ))}
        </nav>

        {selected ? (
          <article className="sd-resource-preview">
            <div className="sd-resource-preview-head">
              <div>
                <span className="kind">{selected.kind}</span>
                <span className="filename">{selected.path}</span>
              </div>
              <span className="cap-pill ver">{selected.group}</span>
            </div>
            {selected.summary ? (
              <div className="sd-resource-summary">
                <p>{selected.summary}</p>
              </div>
            ) : null}
            {selected.preview_status === "loaded" ? (
              selected.kind === "svg" ? (
                <div className="sd-resource-visual" dangerouslySetInnerHTML={{ __html: selected.preview ?? "" }} />
              ) : (
                <div className="sd-resource-code">
                  <pre>{selected.preview}</pre>
                </div>
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

function SkillPermissionList({ detail }: { detail: SkillDetail }) {
  return (
    <div className="sd-card">
      <h4>Declared capability requirements</h4>
      <div className="sd-perm-list">
        <PermLine
          label="Network access"
          state={detail.capabilities.network ? "warn" : "no"}
          scope={detail.capabilities.network ? "allowed" : "not declared"}
        />
        <PermLine
          label="Filesystem"
          state={detail.capabilities.filesystem === "readwrite" ? "warn" : "ok"}
          scope={detail.capabilities.filesystem}
        />
        <PermLine
          label="MCP tools"
          state={detail.capabilities.tools.length > 0 ? "ok" : "no"}
          scope={detail.capabilities.tools.join(", ") || "none"}
        />
        <PermLine
          label="Actions"
          state={detail.actions.length > 0 ? "ok" : "no"}
          scope={detail.actions.join(", ") || "none"}
        />
      </div>
    </div>
  );
}

function PermLine({
  label,
  state,
  scope
}: {
  label: string;
  state: "ok" | "warn" | "no";
  scope: string;
}) {
  const Icon = state === "ok" ? CheckCircle2 : state === "warn" ? AlertTriangle : Minus;
  return (
    <div className="sd-perm-row">
      <span className={`ico ${state}`}><Icon /></span>
      <span>{label}</span>
      <span className="scope">{scope}</span>
    </div>
  );
}

function SkillProvenanceTimeline({ detail }: { detail: SkillDetail }) {
  const source = detail.provenance.source;
  const sourcePip =
    source.status === "present"
      ? "ok"
      : source.status === "tampered" || source.status === "unparseable"
        ? "bad"
        : "";
  return (
    <div className="sd-prov-timeline">
      <div className="sd-prov-row">
        <span className="pip ok"><ShieldCheck /></span>
        <div>
          <div className="ttl">Signed locally</div>
          <div className="det">Ed25519 detached signature, verified on read</div>
        </div>
        <span className="when">{detail.provenance.integrity}</span>
      </div>
      <div className="sd-prov-row">
        <span className={`pip ${sourcePip}`}>{sourcePip === "bad" ? <AlertTriangle /> : sourcePip === "ok" ? <CheckCircle2 /> : <Minus />}</span>
        <div>
          <div className="ttl">{source.label}</div>
          <div className="det">{source.identifier ? <code>{source.identifier}</code> : "No identifier recorded"}</div>
        </div>
        <span className="when">{source.status}</span>
      </div>
      {source.content_hash ? (
        <div className="sd-prov-row">
          <span className="pip ok"><CheckCircle2 /></span>
          <div>
            <div className="ttl">Content hash</div>
            <div className="det"><code>{shortHash(source.content_hash)}</code></div>
          </div>
          <span className="when">sha-256</span>
        </div>
      ) : null}
      {source.fetched_at ? (
        <div className="sd-prov-row">
          <span className="pip ok"><CheckCircle2 /></span>
          <div>
            <div className="ttl">Fetched from source</div>
            <div className="det">{source.fetched_at}</div>
          </div>
          <span className="when">fetched</span>
        </div>
      ) : null}
      {source.reason ? (
        <div className="sd-prov-row">
          <span className="pip bad"><AlertTriangle /></span>
          <div>
            <div className="ttl">Needs review</div>
            <div className="det">{source.reason}</div>
          </div>
          <span className="when">flag</span>
        </div>
      ) : null}
    </div>
  );
}

function sourceBadgeVariant(status: SkillProvenance["source"]["status"]): string {
  if (status === "present") return "";
  if (status === "tampered" || status === "unparseable") return "rejected";
  return "held";
}

function agentSwatch(agent: string): string {
  const palette = ["var(--av-mint)", "var(--av-blue)", "var(--av-violet)", "var(--av-warn)"];
  let hash = 0;
  for (let index = 0; index < agent.length; index += 1) {
    hash = (hash * 31 + agent.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length];
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
              className={`sync-row ${resource.installable ? "av-state-admit" : "av-state-held"}`}
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
