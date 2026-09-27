import { useEffect, useState } from 'react';
import type { DesktopApi } from '../../../../packages/protocol/src/index';
import type { TaskTemplate } from '../../../../packages/protocol/src/continuity';

export function TemplatePicker({ api, current, onApply, setNotice }: {
  api: DesktopApi;
  current: Omit<TaskTemplate, 'id' | 'name'>;
  onApply: (template: TaskTemplate) => void;
  setNotice: (message: string) => void;
}) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = async () => { try { const page = await api.invoke('templates.list', {}); setTemplates(page.items); setNextAfter(page.nextAfter); } catch (error) { setNotice(`Could not load templates: ${error instanceof Error ? error.message : String(error)}`); } };
  const loadMore = async () => { if (!nextAfter) return; try { const page = await api.invoke('templates.list', { after: nextAfter }); setTemplates(current => [...current, ...page.items]); setNextAfter(page.nextAfter); } catch (error) { setNotice(`Could not load more templates: ${error instanceof Error ? error.message : String(error)}`); } };
  useEffect(() => { void reload(); }, [api]);
  const save = async () => {
    if (!name.trim() || busy) return; setBusy(true);
    try { const template = await api.invoke('templates.save', { id: crypto.randomUUID(), name: name.trim(), ...current }); setName(''); setSelected(template.id); await reload(); setNotice(`Saved template "${template.name}". Review its fields whenever you apply it.`); }
    catch (error) { setNotice(`Could not save template: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected || busy) return; setBusy(true);
    try { await api.invoke('templates.remove', { templateId: selected }); setSelected(''); await reload(); }
    catch (error) { setNotice(`Could not remove template: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };
  const preview = templates.find(template => template.id === selected);
  return <div className="template-picker"><h3>Task templates</h3><p className="muted">Templates prepare settings and a draft prompt. They do not carry approvals or start a task.</p><label>Apply template <select value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose a template</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>{preview && <div className="automation-card" aria-label="Template preview"><strong>{preview.name}</strong><small>{preview.mode} · {preview.tokenBudget.toLocaleString()} tokens · profile {preview.profileId}</small><p>Scope guidance: {preview.scope.join(', ') || 'None'}. Scope text guides the prompt; it grants no filesystem permission.</p><pre>{preview.prompt}</pre></div>}{nextAfter && <button type="button" className="quiet" onClick={() => void loadMore()}>More templates</button>}<div className="approval-actions"><button type="button" className="secondary" disabled={!selected} onClick={() => { const item = templates.find(template => template.id === selected); if (item) onApply(item); }}>Apply for review</button><button type="button" className="quiet" disabled={!selected || busy} onClick={() => void remove()}>Remove</button></div><label>Save current setup as <input value={name} onChange={event => setName(event.target.value)} placeholder="Template name" /></label><button type="button" className="secondary" disabled={!name.trim() || busy} onClick={() => void save()}>Save template</button></div>;
}
