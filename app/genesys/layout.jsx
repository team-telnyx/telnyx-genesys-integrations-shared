import GenesysThemeToggle from "@/components/genesys/GenesysThemeToggle";

export const metadata = {
  title: "Telnyx Genesys Integrations",
  description: "Telnyx SMS/MMS integration with Genesys Cloud Open Messaging",
};

const defaultTheme = process.env.NEXT_PUBLIC_GENESYS_APP_THEME || "light";

export default function GenesysLayout({ children }) {
  return (
    <section
      className="min-h-screen bg-background text-foreground antialiased"
      data-genesys-app
      data-theme-default={defaultTheme}
    >
      <GenesysThemeToggle defaultTheme={defaultTheme} />
      {children}
    </section>
  );
}
