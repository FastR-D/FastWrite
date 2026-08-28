import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, currentTheme, THEME_CHANGE_EVENT, type Theme } from "../../lib/theme";
import { IconButton } from "./Button";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  useEffect(() => {
    const sync = () => setTheme(currentTheme());
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);
  const dark = theme === "dark";
  return <IconButton label={dark ? "Use light theme" : "Use dark theme"} icon={dark ? <Sun /> : <Moon />} onClick={() => applyTheme(dark ? "light" : "dark")} />;
}
