"use client";

import { useEffect, useRef, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const GENESYS_THEME_KEY = "genesys.theme";
const PORTAL_THEME_KEY = "theme";

function normalizeTheme(value) {
  return value === "dark" || value === "light" || value === "system" ? value : null;
}

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export default function GenesysThemeToggle({ defaultTheme = "light", variant = "floating" }) {
  const pathname = usePathname();
  const lightOnly = pathname?.startsWith("/genesys/ai-conversation-widget");
  const databasePreference = pathname?.startsWith("/genesys/admin") ||
    pathname?.startsWith("/genesys/widget-admin");
  const suppressedByAdminToolbar = databasePreference && variant !== "toolbar";
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const normalizedDefaultTheme = normalizeTheme(defaultTheme) || "light";
  const [selectedTheme, setSelectedTheme] = useState(normalizedDefaultTheme);
  const previousPortalThemeRef = useRef(null);
  const appliedThemeRef = useRef(null);
  const userSelectionVersionRef = useRef(0);

  useEffect(() => {
    if (suppressedByAdminToolbar) return undefined;
    previousPortalThemeRef.current = localStorage.getItem(PORTAL_THEME_KEY);
    const storedTheme = lightOnly
      ? null
      : normalizeTheme(localStorage.getItem(GENESYS_THEME_KEY));
    const initialTheme = lightOnly ? "light" : storedTheme || normalizedDefaultTheme;

    function restoreStoredPortalTheme() {
      const previousTheme = previousPortalThemeRef.current;

      if (previousTheme) {
        localStorage.setItem(PORTAL_THEME_KEY, previousTheme);
      } else {
        localStorage.removeItem(PORTAL_THEME_KEY);
      }
    }

    appliedThemeRef.current = initialTheme;
    setSelectedTheme(initialTheme);
    setTheme(initialTheme);

    setMounted(true);

    if (databasePreference) {
      const selectionVersion = userSelectionVersionRef.current;
      void fetch("/api/admin/preferences", { cache: "no-store" })
        .then(async (response) => response.ok ? response.json() : null)
        .then((body) => {
          const preferred = normalizeTheme(body?.preferences?.theme);
          if (!preferred || selectionVersion !== userSelectionVersionRef.current) return;
          localStorage.setItem(GENESYS_THEME_KEY, preferred);
          setSelectedTheme(preferred);
          if (appliedThemeRef.current !== preferred) {
            appliedThemeRef.current = preferred;
            setTheme(preferred);
          }
        })
        .catch(() => undefined);
    }
    window.addEventListener("pagehide", restoreStoredPortalTheme);

    return () => {
      window.removeEventListener("pagehide", restoreStoredPortalTheme);
      restoreStoredPortalTheme();

      const previousTheme = previousPortalThemeRef.current;

      if (previousTheme) {
        setTheme(previousTheme);
      } else {
        setTheme("system");
      }
    };
    // Theme changes must not restart this initialization effect: its cleanup
    // restores the portal theme and would produce a visible new-old-new flash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databasePreference, lightOnly, normalizedDefaultTheme, suppressedByAdminToolbar]);

  function handleThemeChange(nextTheme) {
    if (!normalizeTheme(nextTheme)) return;
    userSelectionVersionRef.current += 1;
    appliedThemeRef.current = nextTheme;
    setSelectedTheme(nextTheme);
    localStorage.setItem(GENESYS_THEME_KEY, nextTheme);
    setTheme(nextTheme);
    if (databasePreference) {
      void fetch("/api/admin/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: nextTheme }),
      }).catch(() => undefined);
    }
  }

  if (lightOnly) return null;
  if (suppressedByAdminToolbar) return null;

  const activeTheme = mounted ? normalizeTheme(theme) || selectedTheme : selectedTheme;

  return (
    <div className={variant === "toolbar" ? "shrink-0" : "fixed right-4 top-4 z-50"} data-genesys-theme-toggle>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={activeTheme}
        onValueChange={handleThemeChange}
        aria-label="Color theme"
        className="bg-background"
        suppressHydrationWarning
      >
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <ToggleGroupItem
            key={value}
            value={value}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            className="size-8 flex-none px-0 data-[state=on]:bg-foreground data-[state=on]:text-background"
          >
            <Icon className="size-3.5" />
            <span className="sr-only">{label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
