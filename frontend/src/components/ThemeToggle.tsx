import { Moon, Sun } from "lucide-react";
import { useTheme } from "../theme/useTheme";

export function ThemeToggle({ className = "" }: { className?: string }): React.JSX.Element {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className={`theme-toggle ${className}`}
      onClick={toggleTheme}
      type="button"
    >
      {theme === "dark" ? (
        <Sun aria-hidden="true" size={17} />
      ) : (
        <Moon aria-hidden="true" size={17} />
      )}
    </button>
  );
}
