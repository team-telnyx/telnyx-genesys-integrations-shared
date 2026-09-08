import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare, Search, ArrowRight, Sparkles, MessagesSquare, Users, Bell } from "lucide-react";

export default function HomePage() {
  return (
    <>
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-16 md:py-24">
        {/* Header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-telnyx-green/10 text-telnyx-green text-sm font-medium mb-6">
            <Sparkles className="w-4 h-4" />
            Powered by Telnyx
          </div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-6 text-foreground">
            Genesys Cloud Integrations
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto">
            SMS/MMS messaging and Number Lookup tools for Genesys Cloud agents
          </p>
        </div>

        {/* Main Feature Cards */}
        <div className="grid md:grid-cols-2 gap-6 md:gap-8 max-w-4xl mx-auto mb-16">
          {/* Row 1: Send SMS */}
          <Link href="/sms" className="group block">
            <Card className="h-full border-2 border-transparent hover:border-telnyx-green/50 transition-all duration-300 hover:shadow-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-2xl flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-telnyx-green flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <MessageSquare className="w-5 h-5 text-white" />
                  </div>
                  Send SMS
                  <ArrowRight className="w-5 h-5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 text-telnyx-green ml-auto" />
                </CardTitle>
                <CardDescription className="text-base">
                  Send SMS messages to customers with real-time delivery tracking
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Alphanumeric sender ID support
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Unicode & emoji support
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Delivery status webhooks
                  </li>
                </ul>
              </CardContent>
            </Card>
          </Link>

          {/* Row 1: SMS Campaign */}
          <Link href="/sms-campaign" className="group block">
            <Card className="h-full border-2 border-transparent hover:border-telnyx-green/50 transition-all duration-300 hover:shadow-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-2xl flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-telnyx-green flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <MessagesSquare className="w-5 h-5 text-white" />
                  </div>
                  SMS Campaign
                  <ArrowRight className="w-5 h-5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 text-telnyx-green ml-auto" />
                </CardTitle>
                <CardDescription className="text-base">
                  Send bulk SMS campaigns using Genesys contact lists and templates
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Contact list integration
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Template variable substitution
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Batch message delivery
                  </li>
                </ul>
              </CardContent>
            </Card>
          </Link>

          {/* Row 2: Number Lookup */}
          <Link href="/number-lookup" className="group block">
            <Card className="h-full border-2 border-transparent hover:border-telnyx-green/50 transition-all duration-300 hover:shadow-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-2xl flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-telnyx-green flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <Search className="w-5 h-5 text-white" />
                  </div>
                  Number Lookup
                  <ArrowRight className="w-5 h-5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 text-telnyx-green ml-auto" />
                </CardTitle>
                <CardDescription className="text-base">
                  Verify phone numbers and get carrier information instantly
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Carrier identification
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Caller name (CNAM) lookup
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Line type detection
                  </li>
                </ul>
              </CardContent>
            </Card>
          </Link>

          {/* Row 2: Number Lookup Campaign */}
          <Link href="/number-lookup-campaign" className="group block">
            <Card className="h-full border-2 border-transparent hover:border-telnyx-green/50 transition-all duration-300 hover:shadow-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-2xl flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-telnyx-green flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <Users className="w-5 h-5 text-white" />
                  </div>
                  NL Campaign
                  <ArrowRight className="w-5 h-5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 text-telnyx-green ml-auto" />
                </CardTitle>
                <CardDescription className="text-base">
                  Enrich contact lists with carrier and caller information
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Bulk number lookups
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Auto-update contact data
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Carrier & CNAM enrichment
                  </li>
                </ul>
              </CardContent>
            </Card>
          </Link>

          {/* Row 3: Genesys Notifications */}
          <Link href="/genesys-notifications" className="group block md:col-span-2">
            <Card className="h-full border-2 border-transparent hover:border-telnyx-green/50 transition-all duration-300 hover:shadow-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-2xl flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-telnyx-green flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                    <Bell className="w-5 h-5 text-white" />
                  </div>
                  Genesys WebSocket Notifications
                  <ArrowRight className="w-5 h-5 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 text-telnyx-green ml-auto" />
                </CardTitle>
                <CardDescription className="text-base">
                  Subscribe to Genesys Cloud notification topics and monitor live WebSocket events
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Topic catalogue grouped by functional area
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Queue, user, flow and campaign object pickers for topic placeholders
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-telnyx-green" />
                    Active subscription removal and live JSON event windows
                  </li>
                </ul>
              </CardContent>
            </Card>
          </Link>
        </div>

        {/* Footer Links */}
        <div className="flex flex-wrap justify-center gap-4 text-sm">
          <Link 
            href="/docs" 
            className="px-4 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            API Documentation
          </Link>
        </div>
      </div>
    </div>
    </>
  );
}
