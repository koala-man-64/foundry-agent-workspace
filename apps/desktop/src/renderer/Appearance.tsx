import { useId } from 'react';
import { STYLES, STYLE_LABELS, THEMES, THEME_LABELS, type StylePreference, type ThemePreference } from './theme';

/** The theme and style choices: each one of a closed list of compiled-in presets, never a custom value. */
export function AppearanceSettings({ theme, onChange, style, onStyleChange }: { theme: ThemePreference; onChange: (theme: ThemePreference) => void; style: StylePreference; onStyleChange: (style: StylePreference) => void }) {
  const id = useId().replace(/:/g, '');
  return <>
    <fieldset className="appearance-settings" aria-describedby={`theme-help-${id}`}>
      <legend>Theme</legend>
      <div className="appearance-options">{THEMES.map(value => <label key={value} className="checkbox-row"><input type="radio" name="foundry-theme" value={value} checked={theme === value} onChange={() => onChange(value)} />{THEME_LABELS[value]}</label>)}</div>
      <small id={`theme-help-${id}`}>System follows the Windows app mode. Whatever you choose, the window title bar follows Windows, and a Windows contrast theme replaces these colours.</small>
    </fieldset>
    <fieldset className="appearance-settings" aria-describedby={`style-help-${id}`}>
      <legend>Style</legend>
      <div className="appearance-options">{STYLES.map(value => <label key={value} className="checkbox-row"><input type="radio" name="foundry-style" value={value} checked={style === value} onChange={() => onStyleChange(value)} />{STYLE_LABELS[value]}</label>)}</div>
      <small id={`style-help-${id}`}>Compact uses smaller text and tighter spacing so more fits on screen. Controls stay at least 24px.</small>
    </fieldset>
  </>;
}
