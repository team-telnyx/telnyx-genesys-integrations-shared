"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { usePathname } from "next/navigation";

export function ThemeProvider({ children, ...props }) {
  const pathname = usePathname();
  const widgetLightOnly = pathname?.startsWith("/genesys/ai-conversation-widget");

  return (
    <NextThemesProvider
      {...props}
      forcedTheme={widgetLightOnly ? "light" : props.forcedTheme}
    >
      {children}
    </NextThemesProvider>
  );
}
