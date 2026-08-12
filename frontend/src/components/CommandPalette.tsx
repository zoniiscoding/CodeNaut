import { CornerDownLeft, FolderGit2, Search, Settings, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Repository } from "../api/contracts";
import { useTheme } from "../theme/useTheme";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run(): void;
}

export function CommandPalette({
  repositories,
  open,
  onClose,
}: {
  repositories: Repository[];
  open: boolean;
  onClose(): void;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const { toggleTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const commands = useMemo<Command[]>(() => {
    const repositoryCommands = repositories.map((repository) => ({
      id: `repo-${repository.id}`,
      label: repository.github_full_name,
      hint: "Open repository",
      icon: <FolderGit2 aria-hidden="true" size={15} />,
      run: () => navigate(`/repositories/${repository.id}`),
    }));
    return [
      ...repositoryCommands,
      {
        id: "nav-repositories",
        label: "Go to repositories",
        icon: <Search aria-hidden="true" size={15} />,
        run: () => navigate("/repositories"),
      },
      {
        id: "nav-settings",
        label: "Go to settings",
        icon: <Settings aria-hidden="true" size={15} />,
        run: () => navigate("/settings"),
      },
      {
        id: "toggle-theme",
        label: "Toggle light / dark theme",
        icon: <Sun aria-hidden="true" size={15} />,
        run: toggleTheme,
      },
    ];
  }, [navigate, repositories, toggleTheme]);

  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return commands.slice(0, 8);
    return commands
      .filter((command) => command.label.toLocaleLowerCase().includes(needle))
      .slice(0, 8);
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
    return () => previousFocus.current?.focus();
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  function choose(command: Command | undefined): void {
    if (!command) return;
    command.run();
    onClose();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(matches[activeIndex]);
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
      <div
        aria-label="Command palette"
        aria-modal="true"
        className="palette"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="palette__search">
          <Search aria-hidden="true" size={16} />
          <input
            aria-activedescendant={matches[activeIndex]?.id}
            aria-controls="palette-results"
            aria-expanded="true"
            autoComplete="off"
            className="palette__input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search repositories and actions…"
            ref={inputRef}
            role="combobox"
            value={query}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette__results" id="palette-results" role="listbox">
          {matches.length === 0 ? (
            <li className="palette__empty">No matching commands</li>
          ) : (
            matches.map((command, index) => (
              <li
                aria-selected={index === activeIndex}
                className={`palette__item${index === activeIndex ? " palette__item--active" : ""}`}
                id={command.id}
                key={command.id}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
              >
                <button onClick={() => choose(command)} type="button">
                  {command.icon}
                  <span>{command.label}</span>
                  {command.hint ? <small>{command.hint}</small> : null}
                  {index === activeIndex ? <CornerDownLeft aria-hidden="true" size={13} /> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
