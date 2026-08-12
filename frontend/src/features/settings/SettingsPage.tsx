import { Check, Github, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type { Installation, Repository } from "../../api/contracts";
import { useAuth } from "../../auth/useAuth";
import { Avatar } from "../../components/Avatar";
import { StatusBadge } from "../../components/StatusBadge";
import { Button, EmptyState, InlineAlert, Input, Panel } from "../../components/ui";
import { AVATAR_COLORS } from "../../utils/avatarColors";
import { effectiveName, shortSha } from "../../utils/format";

function AccountCard(): React.JSX.Element {
  const { user, updateUser, accessToken } = useAuth();
  const [nameInput, setNameInput] = useState(user?.custom_display_name ?? "");
  const [colorInput, setColorInput] = useState<string | null>(user?.avatar_color ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const previewName = nameInput.trim() || effectiveName(user);
  const dirty =
    nameInput.trim() !== (user?.custom_display_name ?? "") ||
    colorInput !== (user?.avatar_color ?? null);

  async function save(): Promise<void> {
    if (!accessToken || !dirty || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const trimmed = nameInput.trim();
      const updated = await api.updateProfile(accessToken, {
        custom_display_name: trimmed.length > 0 ? trimmed : null,
        avatar_color: colorInput,
      });
      updateUser(updated);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2400);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The profile could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel>
      <h2>Account</h2>
      <div className="account-card">
        <Avatar color={colorInput} name={previewName} size="lg" />
        <div className="account-card__fields">
          <div className="account-card__field">
            <label htmlFor="display-name-input">Display name</label>
            <Input
              id="display-name-input"
              maxLength={100}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder={user?.display_name ?? user?.github_login ?? "Your name"}
              value={nameInput}
            />
          </div>
          <div className="account-card__field">
            <label id="avatar-color-label">Avatar color</label>
            <div
              aria-labelledby="avatar-color-label"
              className="color-swatch-picker"
              role="radiogroup"
            >
              {AVATAR_COLORS.map((color) => (
                <button
                  aria-checked={colorInput === color}
                  aria-label={`Avatar color ${color}`}
                  className={`color-swatch${colorInput === color ? " color-swatch--selected" : ""}`}
                  key={color}
                  onClick={() => setColorInput(color)}
                  role="radio"
                  style={{ background: color }}
                  type="button"
                >
                  {colorInput === color ? (
                    <Check aria-hidden="true" color="#fff" size={13} />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div className="button-row">
        <Button disabled={!dirty} loading={saving} onClick={() => void save()} variant="primary">
          {saved ? "Saved" : "Save changes"}
        </Button>
        <span className="mono muted">{user?.github_login ?? "Not available"}</span>
      </div>
    </Panel>
  );
}

export function SettingsPage(): React.JSX.Element {
  const { accessToken } = useAuth();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    void Promise.all([
      api.listRepositories(accessToken, controller.signal),
      api.listInstallations(accessToken, controller.signal),
    ])
      .then(([nextRepositories, nextInstallations]) => {
        setRepositories(nextRepositories);
        setInstallations(nextInstallations);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError("Settings data is temporarily unavailable.");
        }
      });
    return () => controller.abort();
  }, [accessToken]);

  return (
    <section className="page settings-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Account and repository access</h1>
          <p>Codenaut uses the server-authorized GitHub App connection for repository access.</p>
        </div>
      </header>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div className="settings-grid">
        <AccountCard />
        <Panel>
          <h2>GitHub connection</h2>
          <p className="settings-copy">
            <Github aria-hidden="true" size={16} /> Active installations are synchronized through
            GitHub. Installations that are suspended or removed immediately lose access.
          </p>
          {installations.length === 0 ? (
            <EmptyState title="No active installation">
              Install the Codenaut GitHub App, then return to connect repositories.
            </EmptyState>
          ) : (
            <ul className="settings-list">
              {installations.map((installation) => (
                <li key={installation.id}>
                  <span>{installation.account_login}</span>
                  <StatusBadge status={installation.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <Panel>
        <h2>Connected repositories</h2>
        {repositories.length === 0 ? (
          <EmptyState title="No connected repositories">
            Select a repository from your authorized GitHub App installation to create its first
            index.
          </EmptyState>
        ) : (
          <div className="settings-list">
            {repositories.map((repository) => (
              <Link key={repository.id} to={`/repositories/${repository.id}`}>
                <span>
                  <strong>{repository.github_full_name}</strong>
                  <small className="mono">
                    {repository.indexed_branch ?? repository.default_branch} ·{" "}
                    {shortSha(repository.active_commit_sha)}
                  </small>
                </span>
                <StatusBadge status={repository.indexing_status} />
              </Link>
            ))}
          </div>
        )}
        <InlineAlert tone="neutral">
          <ShieldCheck aria-hidden="true" size={16} /> Repository removal/disconnect is not exposed
          by the current backend. Manage GitHub App access in GitHub; the server will revoke access
          when it receives the supported event.
        </InlineAlert>
      </Panel>
    </section>
  );
}

export function RepositorySettingsPage(): React.JSX.Element {
  return (
    <section className="page settings-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Repository settings</p>
          <h1>Repository management</h1>
          <p>Connection state, branch eligibility, and access revocation are server controlled.</p>
        </div>
      </header>
      <InlineAlert tone="neutral">
        The current API supports safe manual reindexing and server-driven revocation. It does not
        expose a browser-driven disconnect or arbitrary branch selection.
      </InlineAlert>
      <Link className="button" to="..">
        Return to repository overview
      </Link>
    </section>
  );
}
