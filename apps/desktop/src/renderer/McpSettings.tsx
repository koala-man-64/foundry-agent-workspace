import { FormEvent, useState } from 'react';
import type { DesktopApi, McpServerStatus } from '../../../../packages/protocol/src/index';

interface Props { api: DesktopApi; servers: McpServerStatus[]; onChanged: () => void; setNotice: (value: string) => void }

interface Draft { id: string; key: string; name: string; command: string; argumentsText: string; cwd: string; environmentText: string; callTimeoutMs: number }

const emptyDraft = (): Draft => ({ id: crypto.randomUUID(), key: '', name: '', command: '', argumentsText: '', cwd: '', environmentText: '', callTimeoutMs: 60000 });

function parseEnvironment(text: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) throw new Error(`Environment line "${trimmed.slice(0, 40)}" must be KEY=value.`);
    environment[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1);
  }
  return environment;
}

/** Configured stdio MCP servers. Tools are listed from a real launch on save; the read-only allowlist is the only thing that skips per-call approval. */
export function McpSettings({ api, servers, onChanged, setNotice }: Props) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();

  const save = async (event: FormEvent) => {
    event.preventDefault(); if (saving) return;
    setSaving(true);
    try {
      const result = await api.invoke('mcp.save', { id: draft.id, key: draft.key.trim(), name: draft.name.trim(), command: draft.command.trim(), arguments: draft.argumentsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), cwd: draft.cwd.trim(), environment: parseEnvironment(draft.environmentText), enabled: true, readOnlyTools: [], callTimeoutMs: draft.callTimeoutMs });
      setNotice(result.tools.length ? `MCP server "${result.name}" connected and listed ${result.tools.length} tool(s). Mark read-only tools below; everything else requires approval per call.${result.lastError ? ` ${result.lastError}` : ''}` : `MCP server "${result.name}" saved with a problem: ${result.lastError ?? 'no tools were listed'}`);
      setDraft(emptyDraft()); onChanged();
    } catch (error) { setNotice(`Could not save MCP server: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setSaving(false); }
  };
  const update = async (server: McpServerStatus, changes: Partial<McpServerStatus>) => {
    if (busy) return; setBusy(server.id);
    try {
      const { tools: _tools, toolsListedAt: _listed, serverInfo: _info, lastError: _error, running: _running, ...config } = { ...server, ...changes };
      const result = await api.invoke('mcp.save', config);
      if (result.lastError) setNotice(`MCP server "${result.name}": ${result.lastError}`);
      onChanged();
    } catch (error) { setNotice(`Could not update MCP server: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(undefined); }
  };
  const remove = async (server: McpServerStatus) => {
    if (busy) return; setBusy(server.id);
    try { await api.invoke('mcp.remove', { serverId: server.id }); onChanged(); }
    catch (error) { setNotice(`Could not remove MCP server: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(undefined); }
  };

  return <section className="mcp-settings" data-testid="mcp-settings">
    <div className="dialog-head"><div><p className="eyebrow">EXTERNAL TOOLS</p><h2>MCP servers</h2></div></div>
    <div className="profile-form">
      <p className="probe-note">Configured stdio servers run in a supervised Windows Job Object with your privileges and a minimal environment. Their tools are advertised to coding tasks as <code>mcp__key__tool</code>. Only tools you mark read-only run without a per-call approval; server annotations are hints and grant nothing. Inputs and outputs are secret-screened and bounded.</p>
      {servers.map((server) => <div className="mcp-server" key={server.id} data-testid={`mcp-server-${server.key}`}>
        <div className="approval-heading"><strong>{server.name} <small>({server.key})</small></strong><span>{server.enabled ? server.running ? 'running' : 'enabled' : 'disabled'}</span></div>
        <p className="muted">{server.command}{server.arguments.length ? ` ${server.arguments.join(' ')}` : ''}{server.serverInfo ? ` · ${server.serverInfo.name} ${server.serverInfo.version}` : ''}{server.toolsListedAt ? ` · listed ${server.tools.length} tool(s)` : ' · not listed yet'}</p>
        {server.lastError && <p className="mcp-error">{server.lastError}</p>}
        {server.tools.length > 0 && <fieldset className="child-profiles"><legend>Read-only allowlist (runs without approval)</legend>
          {server.tools.map((tool) => <label key={tool.name} className="checkbox-row"><input type="checkbox" disabled={Boolean(busy)} checked={server.readOnlyTools.includes(tool.name)} onChange={(e) => void update(server, { readOnlyTools: e.target.checked ? [...server.readOnlyTools, tool.name] : server.readOnlyTools.filter((name) => name !== tool.name) })} />{tool.name}{tool.readOnlyHint ? ' (server hints read-only)' : ''}<small className="muted"> {tool.description.slice(0, 120)}</small></label>)}
        </fieldset>}
        <div className="approval-actions">
          <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void update(server, { enabled: !server.enabled })}>{server.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void update(server, {})}>Reconnect and relist</button>
          <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => void remove(server)}>Remove</button>
        </div>
      </div>)}
      {!servers.length && <p className="muted">No MCP servers are configured.</p>}
      <form onSubmit={save} className="mcp-form">
        <div className="limits">
          <label>Key <input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} placeholder="fixture" pattern="[a-z0-9][a-z0-9-]{0,31}" required aria-label="MCP key" /></label>
          <label>Display name <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={100} aria-label="MCP name" /></label>
        </div>
        <label>Command (absolute .exe path) <input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} required aria-label="MCP command" /></label>
        <label>Arguments (one per line) <textarea value={draft.argumentsText} onChange={(e) => setDraft({ ...draft, argumentsText: e.target.value })} aria-label="MCP arguments" /></label>
        <div className="limits">
          <label>Working directory (optional) <input value={draft.cwd} onChange={(e) => setDraft({ ...draft, cwd: e.target.value })} aria-label="MCP working directory" /></label>
          <label>Call timeout (ms) <input type="number" min={1000} max={600000} value={draft.callTimeoutMs} onChange={(e) => setDraft({ ...draft, callTimeoutMs: Number(e.target.value) })} aria-label="MCP call timeout" /></label>
        </div>
        <label>Environment (KEY=value per line; stored in plain text in the local database, so never put secrets here — credential-like names and secret-like values are refused as a best-effort guard) <textarea value={draft.environmentText} onChange={(e) => setDraft({ ...draft, environmentText: e.target.value })} aria-label="MCP environment" /></label>
        <div className="dialog-actions"><button className="primary" disabled={saving}>{saving ? 'Connecting…' : 'Connect and save server'}</button></div>
      </form>
    </div>
  </section>;
}
