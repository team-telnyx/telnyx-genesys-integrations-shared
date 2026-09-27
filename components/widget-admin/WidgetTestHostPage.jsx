"use client";

import { useEffect, useState } from "react";
import { MessageCircle, Phone, Video, RotateCw, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import GenesysThemeToggle from "@/components/genesys/GenesysThemeToggle";
import { genesysAuthenticatedFetch } from "@/lib/genesys/admin-client-auth";
import { parseWidgetTestContext, storedWidgetTestContext } from "@/lib/widgets/test-page";

export default function WidgetTestHostPage({ widgetId, defaultTheme = "light" }) {
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let loader;
    let publicId;
    let timeout;
    const onStatus = (event) => {
      if (cancelled || event.detail?.publicId !== publicId) return;
      window.clearTimeout(timeout);
      setState((current) => ({ ...current, status: event.detail.status, message: event.detail.message }));
    };
    window.addEventListener("telnyx-widget-test-status", onStatus);
    async function start() {
      try {
        if (!widgetId) throw new Error("Select a widget in Widget Studio, then open Test Page.");
        const parsed = parseWidgetTestContext(storedWidgetTestContext(window.localStorage));
        if (parsed.error) throw new Error(parsed.error);
        const response = await genesysAuthenticatedFetch(`/api/admin/widgets/${encodeURIComponent(widgetId)}/test-grant`, {
          method: "POST", cache: "no-store",
        });
        const body = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) {
          setState({ status: response.status === 401 ? "auth" : "error", message: body.error || "Unable to open the widget" });
          return;
        }
        publicId = body.publicId;
        setState({ status: "loading", name: body.name, revision: body.revision, publicId, keys: Object.keys(parsed.context) });
        window.TelnyxWidgetContext = { ...parsed.context };
        loader = document.createElement("script");
        loader.src = "/widget/v1/loader.js";
        loader.dataset.widgetId = publicId;
        loader.dataset.testGrant = body.grant;
        loader.onerror = () => { if (!cancelled) setState((current) => ({ ...current, status: "error", message: "The widget loader could not be loaded." })); };
        timeout = window.setTimeout(() => {
          if (!cancelled) setState((current) => current.status === "loading"
            ? { ...current, status: "error", message: "Loading timed out. Reload the widget to try again." } : current);
        }, 20_000);
        document.body.appendChild(loader);
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: error.message });
      }
    }
    void start();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("telnyx-widget-test-status", onStatus);
      loader?.remove();
      if (publicId) document.getElementById(`telnyx-widget-${publicId}`)?.remove();
    };
  }, [widgetId]);

  const failed = ["error", "auth", "hidden"].includes(state.status);
  const returnTo = `/genesys/widget-test?widget=${encodeURIComponent(widgetId)}`;
  return <div className="min-h-screen bg-muted/30 text-foreground">
    <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b px-5 py-3 ${failed ? "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100" : "bg-background text-muted-foreground"}`}>
      <div className="min-w-0 flex-1 basis-64 break-words text-xs" role="status" data-testid="widget-test-host-status">
        {state.status === "loading" ? <div className="flex flex-wrap items-center gap-3">Loading published widget<Skeleton className="h-4 w-36" /></div>
          : failed ? <div className="flex flex-wrap items-center gap-3"><span>{state.message}</span>
            {state.status === "auth" ? <Button asChild size="sm" variant="outline"><a target="_blank" rel="noopener noreferrer" href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}><LogIn />Sign in with Genesys</a></Button>
              : <Button size="sm" variant="outline" onClick={() => window.location.reload()}><RotateCw />Reload widget</Button>}
          </div>
            : <>Test page · <strong>{state.name}</strong> · revision {state.revision}<span className="ml-2 break-all font-mono">{state.publicId}</span></>}
      </div>
      <GenesysThemeToggle defaultTheme={defaultTheme} variant="toolbar" />
    </div>
    <header className="border-b bg-background px-6 py-6 sm:px-10">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
        <div><p className="text-lg font-semibold tracking-tight">Example Company</p><p className="mt-1 text-xs text-muted-foreground">Customer website · widget test</p></div>
        <nav className="flex gap-5 text-sm text-muted-foreground" aria-label="Test site navigation"><a href="#services">Services</a><a href="#support">Support</a></nav>
      </div>
    </header>
    <main className="mx-auto max-w-5xl px-6 py-12 sm:px-10">
      <section className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-emerald-700 dark:text-emerald-400">Customer support</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">How can we help?</h1>
        <p className="mt-5 text-base leading-7 text-muted-foreground">Open the widget to try the channels configured for this website. Conversations and calls reach your connected Genesys and Telnyx services.</p>
      </section>
      <section id="services" className="mt-10 grid gap-4 md:grid-cols-3" aria-label="Support channels">
        {[
          [MessageCircle, "Message us", "Ask a question and continue the conversation with an agent."],
          [Phone, "Start a call", "Talk to our team directly from your browser."],
          [Video, "Meet on video", "Connect face to face and share your screen when needed."],
        ].map(([Icon, title, copy]) => <article key={title} className="rounded-2xl border bg-card p-6 text-card-foreground shadow-sm">
          <Icon className="size-6 text-emerald-700 dark:text-emerald-400" /><h2 className="mt-5 font-semibold">{title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{copy}</p>
        </article>)}
      </section>
      <section id="support" className="mt-8 rounded-2xl border bg-card p-6 text-card-foreground">
        <h2 className="text-lg font-semibold">Your test session</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">This page uses the published widget. Change the selected widget or its test context in Widget Studio, then reload to start another test.</p>
        {state.status === "loading" ? <Skeleton className="mt-4 h-10 w-full" /> : state.keys?.length ? <p className="mt-4 break-words text-xs text-muted-foreground">Context: {state.keys.join(", ")}</p> : null}
      </section>
    </main>
  </div>;
}
