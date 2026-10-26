import { THEMES, THEME_LABELS, type ThemePreference } from './theme';

/** The theme choice: one of a closed list of compiled-in presets, never a custom value. */
export function AppearanceSettings({ theme, onChange }: { theme: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  return <fieldset className="appearance-settings">
    <legend>Theme</legend>
    <div className="appearance-options">{THEMES.map(value => <label key={value} className="checkbox-row"><input type="radio" name="foundry-theme" value={value} checked={theme === value} onChange={() => onChange(value)} />{THEME_LABELS[value]}</label>)}</div>
    <small>System follows the Windows app mode. The window title bar always follows it.</small>
  </fieldset>;
}
