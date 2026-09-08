"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import CodeBlock from "@/components/ui/code-block";
import { toast } from "sonner";
import { count as smsCount } from "sms-length";
import { useTheme } from "next-themes";
import { CheckIcon, Send, Home } from "lucide-react";
import Link from "next/link";
import EmojiPicker from "@/components/sms/EmojiPicker";
import { genesysAuthenticatedFetch } from "@/lib/genesys/admin-client-auth";

function computeEncodingStats(text) {
  try {
    const r = smsCount(text || "");
    const encoding = r.encoding === "GSM_7BIT" ? "GSM-7" : "UCS-2";
    const parts = r.messages || 1;
    const perPart = r.characterPerMessage || (encoding === "GSM-7" ? 160 : 70);
    const remaining = r.remaining ?? Math.max(0, perPart - (r.inCurrentMessage || 0));
    return { encoding, parts, perPart, remaining };
  } catch (_) {
    const isAscii = /^[\u0000-\u007F]*$/.test(text || "");
    const perPart = isAscii ? 160 : 70;
    const concatPerPart = isAscii ? 153 : 67;
    const length = [...(text || "")].length;
    const parts = length <= perPart ? 1 : Math.ceil(length / concatPerPart);
    const remaining =
      (length <= perPart ? perPart : concatPerPart) -
      (length % (length <= perPart ? perPart : concatPerPart) || (length <= perPart ? perPart : concatPerPart));
    return {
      encoding: isAscii ? "GSM-7" : "UCS-2",
      parts,
      perPart,
      remaining,
    };
  }
}

export default function SmsForm({ accessToken }) {
  const [fromNumbers, setFromNumbers] = useState([]);
  const [fromChoice, setFromChoice] = useState("Telnyx");
  const [toNumber, setToNumber] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  
  // Status tracking
  const [lastMessageId, setLastMessageId] = useState(null);
  const [statusData, setStatusData] = useState({ status: null, webhooks: [] });
  const [isPolling, setIsPolling] = useState(false);
  const [lastSendResponse, setLastSendResponse] = useState(null);
  const [openPayload, setOpenPayload] = useState(null);
  
  const stats = computeEncodingStats(message);
  const textareaRef = useRef(null);
  const { resolvedTheme, theme, forcedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [pickerTheme, setPickerTheme] = useState("light");
  
  useEffect(() => {
    setMounted(true);
  }, []);
  
  // Detect actual theme from DOM (works with forcedTheme)
  useEffect(() => {
    if (mounted) {
      const isDark = document.documentElement.classList.contains("dark");
      setPickerTheme(isDark ? "dark" : "light");
    }
  }, [mounted, forcedTheme, resolvedTheme, theme]);

  // Load initial data from Genesys
  useEffect(() => {
    if (accessToken) {
      loadGenesysData();
    }
  }, [accessToken]);

  // Polling for status updates
  useEffect(() => {
    let interval;
    if (lastMessageId && isPolling) {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/sms/status?id=${lastMessageId}`);
          const data = await res.json();
          
          if (data.status) {
            const eventType = data.status.toLowerCase() === 'delivered' ? 'message.finalized' :
                             data.status.toLowerCase() === 'sent' ? 'message.sent' : null;
            
            if (eventType) {
              setStatusData((prev) => ({
                status: data.status,
                webhooks: [
                  ...(prev.webhooks || []),
                  { data: { event_type: eventType }, record: data },
                ],
              }));
            }
            
            if (['delivered', 'failed', 'undelivered', 'expired'].includes(data.status.toLowerCase())) {
              setIsPolling(false);
              if (data.status.toLowerCase() === 'delivered') {
                toast.success('Message Delivered!');
              } else {
                toast.error(`Delivery Failed: ${data.status}`);
              }
            }
          }
        } catch (e) {
          console.error('Polling error', e);
        }
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [lastMessageId, isPolling]);

  const loadGenesysData = async () => {
    setIsLoading(true);
    try {
      // Get User Queues
      const queuesRes = await genesysAuthenticatedFetch('/api/genesys/queues');
      const queuesData = await queuesRes.json();
      const queueNames = (queuesData.entities || []).map(q => q.name);

      // Get Data Table Rows for "From" numbers
      const tableName = process.env.NEXT_PUBLIC_GC_SMS_FROM_TABLE_NAME;
      
      if (tableName) {
        const tableRes = await genesysAuthenticatedFetch(`/api/genesys/datatables?name=${encodeURIComponent(tableName)}`);
        const tableData = await tableRes.json();
        
        if (tableData.entities && tableData.entities.length > 0) {
          const matchedRows = tableData.entities.filter(row => queueNames.includes(row.queue));
          
          const options = matchedRows.map(row => ({
            id: row.key,
            value: row.from,
            label: row.from
          }));

          if (options.length === 0) {
            const defaultId = process.env.NEXT_PUBLIC_GC_SMS_FROM_DEFAULT_ID;
            if (defaultId) {
              options.push({
                id: 'default',
                value: defaultId,
                label: defaultId
              });
            }
          }
          
          setFromNumbers(options);
          if (options.length > 0) setFromChoice(options[0].value);
        }
      }

      // Get Active Conversations to pre-fill To number
      const convRes = await genesysAuthenticatedFetch('/api/genesys/conversations');
      const convData = await convRes.json();
      
      if (convData.entities && convData.entities.length > 0) {
        const activeConv = convData.entities[0];
        const participant = activeConv.participants?.find(p => 
          p.purpose === 'external' || p.participantType === 'External'
        );
        
        if (participant && participant.ani) {
          const ani = participant.ani.replace('tel:', '');
          setToNumber(ani);
          toast.info(`Pre-filled from conversation with ${ani}`);
        }
      }
    } catch (error) {
      console.error('Error loading Genesys data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  function insertEmojiAtCaret(emoji) {
    const el = textareaRef.current;
    if (!el) {
      setMessage((prev) => (prev || "") + emoji);
      return;
    }
    const start = el.selectionStart ?? (message ? message.length : 0);
    const end = el.selectionEnd ?? (message ? message.length : 0);
    setMessage((prev) => {
      const current = prev || "";
      return current.slice(0, start) + emoji + current.slice(end);
    });
    const pos = start + emoji.length;
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        try {
          el.focus();
          el.setSelectionRange(pos, pos);
        } catch (_) {}
      });
    }
  }

  async function onSend() {
    const toE164 = toNumber.trim();
    if (!/^\+?[1-9]\d{6,15}$/.test(toE164)) {
      toast.error("Invalid destination number");
      return;
    }
    if (!message.trim()) {
      toast.error("Message body is empty");
      return;
    }
    
    setIsSending(true);
    setStatusData({ status: null, webhooks: [] });
    setLastMessageId(null);
    
    try {
      const res = await fetch('/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: toE164,
          from: fromChoice,
          text: message
        })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send');
      
      toast.success("Message sent", {
        description: `ID: ${data.messageId || data.id || "n/a"}`,
      });
      setMessage("");
      
      if (data.messageId) {
        setLastMessageId(data.messageId);
        setLastSendResponse(data);
        setIsPolling(true);
      }
    } catch (err) {
      toast.error("Send failed", {
        description: String(err.message || err),
      });
    } finally {
      setIsSending(false);
    }
  }

  const statusSteps = [
    { key: "QUEUED", label: "QUEUED" },
    { key: "message.sent", label: "SENT" },
    { key: "message.finalized", label: "FINALIZED" },
  ];
  
  const events = (statusData.webhooks || [])
    .map((w) => w?.data?.event_type || w?.event_type)
    .filter(Boolean);
  
  const eventToStep = (evt) => {
    if (!evt) return -1;
    const map = {
      "message.sent": 1,
      "message.delivery_status": 1,
      "message.delivered": 1,
      "message.finalized": 2,
      "message.failed": 2,
      "message.undeliverable": 2,
    };
    return typeof map[evt] === "number" ? map[evt] : -1;
  };
  
  const maxStep = Math.max(-1, ...events.map(eventToStep));
  const queuedDone = !!lastMessageId;
  const isStepDone = (idx) => {
    if (idx === 0) return queuedDone;
    return maxStep >= idx;
  };
  const doneKeys = statusSteps.filter((_, idx) => isStepDone(idx)).map((s) => s.key);

  const remainingVariant = stats.remaining <= 10 ? "destructive" : "secondary";
  const encodingVariant = stats.encoding === "UCS-2" ? "destructive" : "secondary";

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Send className="size-6 text-telnyx-green" /> Send SMS
          </CardTitle>
          <Link href="/">
            <Button variant="outline" size="sm">
              <Home className="h-4 w-4 mr-2" />
              Home
            </Button>
          </Link>
        </CardHeader>
        <CardContent className="space-y-4 md:space-y-0 md:flex md:gap-6">
          <div className="flex-1 space-y-4">
            <div className="space-y-2">
              <label className="text-sm">From</label>
              <Tabs
                value={fromChoice}
                onValueChange={(v) => setFromChoice(v)}
                className="w-full"
              >
                <TabsList className="w-full">
                  <TabsTrigger value="Telnyx" className="flex-1">
                    Telnyx
                  </TabsTrigger>
                  {fromNumbers.map((num) => (
                    <TabsTrigger key={num.id} value={num.value} className="flex-1">
                      {num.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            
            <div className="space-y-2">
              <label className="text-sm">To (E.164)</label>
              <Input
                placeholder="+14155550123"
                value={toNumber}
                onChange={(e) => setToNumber(e.target.value)}
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-sm">Message</label>
              <Textarea
                ref={textareaRef}
                rows={6}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type your message…"
              />
              <div className="text-xs text-muted-foreground flex flex-wrap gap-2 items-center">
                <span>Encoding:</span>
                <Badge variant={encodingVariant}>{stats.encoding}</Badge>
                <span>· Parts:</span>
                <Badge variant="secondary">{stats.parts}</Badge>
                <span>· Max:</span>
                <Badge variant="secondary">{stats.perPart}</Badge>
                <span>· Remains:</span>
                <Badge variant={remainingVariant}>{stats.remaining}</Badge>
              </div>
            </div>

            <div className="w-full">
              <div className="w-full flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Status</div>
              </div>
              <div className="w-full">
                <Separator />
                <ToggleGroup
                  type="multiple"
                  value={doneKeys}
                  variant="outline"
                  className="w-full rounded-md"
                >
                  {statusSteps.map((step, idx) => (
                    <ToggleGroupItem
                      key={step.key}
                      className="flex-1 cursor-pointer bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-50"
                      value={step.key}
                      onClick={() => {
                        if (step.key === "QUEUED") {
                          setOpenPayload({
                            title: step.label,
                            data: lastSendResponse || { info: "Queued (no payload available)" },
                          });
                          return;
                        }
                        const hook = (statusData.webhooks || []).find(
                          (w) => (w?.data?.event_type || w?.event_type) === step.key
                        );
                        setOpenPayload({
                          title: step.label,
                          data: hook || { info: "No webhook received yet" },
                        });
                      }}
                    >
                      {step.label}
                      {isStepDone(idx) && (
                        <CheckIcon className="ml-2 text-telnyx-green" />
                      )}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            </div>
            
            <div className="flex items-right justify-end gap-3">
              <Button disabled={isSending || !message || !toNumber} onClick={onSend} className="w-50">
                {isSending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
          
          {/* Emoji picker on desktop */}
          <div className="hidden md:block">
            <div className="text-sm mb-2">Emojis</div>
            <div className="w-full">
              <EmojiPicker
                onEmojiSelect={(e) => insertEmojiAtCaret(e.native)}
                theme={pickerTheme}
              />
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col items-start gap-4"></CardFooter>

        <Sheet open={!!openPayload} onOpenChange={(o) => !o && setOpenPayload(null)}>
          <SheetContent
            side="right"
            className="dark:bg-neutral-900 text-neutral-50 sm:max-w-3xl"
          >
            <SheetHeader>
              <SheetTitle>
                Webhook event details - {"Message " + openPayload?.title}
              </SheetTitle>
            </SheetHeader>
            <div className="p-4">
              <CodeBlock
                wrap={true}
                language="json"
                data={openPayload?.data}
                height="90vh"
                className="bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-50"
              />
            </div>
          </SheetContent>
        </Sheet>
      </Card>
    </div>
  );
}
