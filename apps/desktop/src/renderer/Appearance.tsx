import { useId } from 'react';
import { THEMES, THEME_LABELS, type ThemePreference } from './theme';

/** The theme choice: one of a closed list of compiled-in presets, never a custom value. */
export function AppearanceSettings({ theme, onChange }: { theme: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  const helpId = `theme-help-${useId().replace(/:/g, '')}`;
  return <fieldset className="appearance-settings" aria-describedby={helpId}>
    <legend>Theme</legend>
    <div className="appearance-options">{THEMES.map(value => <label key={value} className="checkbox-row"><input type="radio" name="foundry-theme" value={value} checked={theme === value} onChange={() => onChange(value)} />{THEME_LABELS[value]}</label>)}</div>
    <small id={helpId}>System follows the Windows app mode. Whatever you choose, the window title bar follows Windows, and a Windows contrast theme replaces these colours.</small>
  </fieldset>;
}
