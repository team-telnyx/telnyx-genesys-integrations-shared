import WidgetFrame from "@/components/widget/WidgetFrame";

export const metadata = { title: "Contact widget" };

export default function WidgetFramePage() {
  return (
    <>
      {/* The panel draws its own rounded surface inside a transparent iframe, so
          the document behind it must not paint the app background into the corners. */}
      <style dangerouslySetInnerHTML={{ __html: "html,body{background:transparent}" }} />
      <WidgetFrame />
    </>
  );
}
