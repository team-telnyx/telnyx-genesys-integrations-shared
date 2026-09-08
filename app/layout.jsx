import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Telnyx Genesys Integrations",
  description: "Telnyx SMS/MMS integration with Genesys Cloud Open Messaging",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/telnyx_green_transparent.png",
  },
};

// Get default theme from env (light | dark | system)
const defaultTheme = process.env.NEXT_PUBLIC_APP_THEME || "system";

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme={defaultTheme}
          forcedTheme={defaultTheme !== "system" ? defaultTheme : undefined}
          enableSystem={defaultTheme === "system"}
          disableTransitionOnChange
        >
          {children}
          <Toaster 
            position="top-right" 
            richColors 
            theme={defaultTheme === "system" ? "system" : defaultTheme}
            toastOptions={{
              classNames: {
                toast: 'bg-card border-border shadow-lg',
                title: 'text-card-foreground',
                description: 'text-muted-foreground',
              },
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
