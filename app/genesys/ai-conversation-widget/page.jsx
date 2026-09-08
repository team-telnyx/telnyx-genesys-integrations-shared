import { Suspense } from "react";
import GenesysAiConversationWidget from "@/components/genesys-ai/GenesysAiConversationWidget";

export const metadata = { title: "Telnyx AI Conversation | Genesys Cloud" };

export default function GenesysAiConversationWidgetPage() {
  return <Suspense fallback={<div className="h-screen bg-white" />}><GenesysAiConversationWidget /></Suspense>;
}
