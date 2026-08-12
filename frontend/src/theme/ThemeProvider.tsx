import { useCallback, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";
import { ThemeContext } from "./context";
import type { ThemeMode } from "./context";

const STORAGE_KEY = "codenaut-theme";

function initialTheme(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  const attribute = document.documentElement.dataset.theme;
  return attribute === "light" ? "light" : "dark";
}

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);

  const toggleTheme = useCallback((): void => {
    setTheme((current) => {
      const next: ThemeMode = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage may be unavailable (private browsing); the in-memory theme still applies.
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
