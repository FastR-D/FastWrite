import { useEffect, useState } from "react";
import { applyTheme, currentTheme, THEME_CHANGE_EVENT, type Theme } from "../../../lib/theme";
import { IconButton } from "../primitives/IconButton";
import { Icon } from "../primitives/Icon";
import { icons } from "../icons";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  useEffect(() => {
    const sync = () => setTheme(currentTheme());
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);
  const dark = theme === "dark";
  return <IconButton label={dark ? "Use light theme" : "Use dark theme"} icon={<Icon name={icons.colorMode} />} onClick={() => applyTheme(dark ? "light" : "dark")} />;
}
