"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme, type ThemeKey } from "@/components/ThemeProvider";

const themeOptions: { key: ThemeKey; label: string; icon: typeof Sun }[] = [
  { key: "bright", label: "Light", icon: Sun },
  { key: "dark", label: "Dark", icon: Moon },
];

/**
 * Shared Light/Dark switcher. Used in the sidebar footer and floating on
 * admin pages (which have no sidebar), so the theme can be changed anywhere.
 */
export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();

  return (
    <div className={`grid gap-1 ${compact ? "grid-cols-1" : "grid-cols-2"}`}>
      {themeOptions.map(({ key, label, icon: Icon }) => {
        const active = theme === key;
        return (
          <button
            key={key}
            type="button"
            title={label}
            onClick={() => setTheme(key)}
            className={`flex items-center justify-center gap-2 rounded-[6px] px-2 py-2 text-[12px] font-semibold transition-all ${
              active
                ? "bg-ts-accent-light text-ts-accent border border-ts-accent-border"
                : "text-ts-text-2 hover:bg-ts-surface border border-transparent"
            } ${compact ? "aspect-square p-0" : ""}`}
          >
            <Icon size={16} />
            {!compact && label}
          </button>
        );
      })}
    </div>
  );
}
