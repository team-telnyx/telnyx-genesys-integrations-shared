import GenesysNotificationsMonitor from "@/components/genesys-notifications/GenesysNotificationsMonitor";

export const metadata = {
  title: "Genesys WebSocket Notifications | Telnyx Genesys Integrations",
  description: "Subscribe to Genesys Cloud notification topics and monitor live WebSocket events.",
};

export default function GenesysNotificationsPage() {
  return <GenesysNotificationsMonitor />;
}
