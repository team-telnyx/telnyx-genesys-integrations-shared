import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-16 max-w-5xl">
        <div className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight mb-4 text-foreground">API Documentation</h1>
          <p className="text-xl text-muted-foreground">
            Webhook endpoints and API reference
          </p>
        </div>

        <div className="space-y-8">
          {/* Inbound Webhook */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Badge variant="default">POST</Badge>
                <CardTitle className="text-lg">/api/genesys/sms/inbound</CardTitle>
              </div>
              <CardDescription>
                Telnyx inbound message webhook - forwards SMS to Genesys Cloud Open Messaging
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h4 className="font-medium mb-2 text-foreground">Request Body</h4>
                <pre className="bg-muted p-4 rounded-lg text-sm overflow-x-auto text-foreground">
{`{
  "data": {
    "event_type": "message.received",
    "payload": {
      "id": "msg_123",
      "from": {
        "phone_number": "+12125551234"
      },
      "text": "Hello",
      "tags": ["+12125551234", "listId", "contactId"]
    }
  }
}`}
                </pre>
              </div>
              <div>
                <h4 className="font-medium mb-2 text-foreground">Event Types</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">message.received</code></TableCell>
                      <TableCell>Forward to Genesys Cloud</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">message.sent</code></TableCell>
                      <TableCell>Update contact list status</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">message.finalized</code></TableCell>
                      <TableCell>Update contact list status</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Badge variant="default">POST</Badge>
                <CardTitle className="text-lg">/api/webhooks/telnyx/insights</CardTitle>
              </div>
              <CardDescription>
                Verified Telnyx insights webhook for conversation.insights.completed,
                call.conversation_insights.generated, and conversation_insight_result
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Configure this URL on an AI Insight Group. The endpoint verifies the exact raw
                request body with TELNYX_PUBLIC_KEY before accepting the event.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Required header</TableHead>
                    <TableHead>Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell><code className="bg-muted px-1 rounded">telnyx-signature-ed25519</code></TableCell>
                    <TableCell>Base64 Ed25519 signature</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell><code className="bg-muted px-1 rounded">telnyx-timestamp</code></TableCell>
                    <TableCell>Unix timestamp with a five-minute replay window</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Outbound Webhook */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Badge variant="default">POST</Badge>
                <CardTitle className="text-lg">/api/genesys/sms/outbound</CardTitle>
              </div>
              <CardDescription>
                Genesys Cloud outbound message webhook - sends SMS via Telnyx
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h4 className="font-medium mb-2 text-foreground">Request Body</h4>
                <pre className="bg-muted p-4 rounded-lg text-sm overflow-x-auto text-foreground">
{`{
  "type": "Text",
  "text": "Hello from agent",
  "channel": {
    "to": {
      "id": "+12125551234|listId|contactId"
    }
  }
}`}
                </pre>
              </div>
              <div>
                <h4 className="font-medium mb-2 text-foreground">Headers</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Header</TableHead>
                      <TableHead>Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">x-hub-signature-256</code></TableCell>
                      <TableCell>HMAC SHA-256 signature</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">Content-Type</code></TableCell>
                      <TableCell>application/json</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Agentless */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Badge variant="default">POST</Badge>
                <CardTitle className="text-lg">/api/genesys/sms/agentless</CardTitle>
              </div>
              <CardDescription>
                Send SMS without agent assignment
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h4 className="font-medium mb-2 text-foreground">Request Body</h4>
                <pre className="bg-muted p-4 rounded-lg text-sm overflow-x-auto text-foreground">
{`{
  "number": "+12125551234",
  "text": "Your message here"
}`}
                </pre>
              </div>
              <div>
                <h4 className="font-medium mb-2 text-foreground">Response</h4>
                <pre className="bg-muted p-4 rounded-lg text-sm overflow-x-auto text-foreground">
{`{
  "success": true,
  "conversationId": "abc-123"
}`}
                </pre>
              </div>
            </CardContent>
          </Card>

          {/* Health Check */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">GET</Badge>
                <CardTitle className="text-lg">/api/health</CardTitle>
              </div>
              <CardDescription>
                Health check endpoint
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div>
                <h4 className="font-medium mb-2 text-foreground">Response</h4>
                <pre className="bg-muted p-4 rounded-lg text-sm overflow-x-auto text-foreground">
{`{
  "status": "ok",
  "timestamp": "2024-02-07T12:00:00.000Z",
  "service": "telnyx-genesys-integrations"
}`}
                </pre>
              </div>
            </CardContent>
          </Card>

          {/* Message Tags */}
          <Card>
            <CardHeader>
              <CardTitle>Message Tags & Campaign Tracking</CardTitle>
              <CardDescription>
                How to track campaign delivery status in Genesys contact lists
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Messages can include tags for campaign tracking. Format: <code className="bg-muted px-2 py-1 rounded">number|listId|contactId</code>
              </p>
              <div>
                <h4 className="font-medium mb-2 text-foreground">Contact List Fields (Auto-Updated)</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Field</TableHead>
                      <TableHead>Description</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">TELNYX_STATUS</code></TableCell>
                      <TableCell>Delivery status (sent, delivered, etc.)</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">TELNYX_TIME</code></TableCell>
                      <TableCell>Timestamp (ISO 8601)</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">TELNYX_PRICE</code></TableCell>
                      <TableCell>Message cost (USD)</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">TELNYX_MESSAGE_ID</code></TableCell>
                      <TableCell>Telnyx message ID</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell><code className="bg-muted px-1 rounded">TELNYX_MESSAGE</code></TableCell>
                      <TableCell>Message text</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
