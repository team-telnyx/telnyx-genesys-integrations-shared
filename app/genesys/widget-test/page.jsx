import WidgetTestHostPage from "@/components/widget-admin/WidgetTestHostPage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Widget Test Page", robots: { index: false, follow: false } };

export default async function Page({ searchParams }) {
  const { widget } = await searchParams;
  return <WidgetTestHostPage widgetId={typeof widget === "string" ? widget : ""} defaultTheme={process.env.NEXT_PUBLIC_GENESYS_APP_THEME || "light"} />;
}
