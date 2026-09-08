"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import CodeBlock from "@/components/ui/code-block";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "sonner";
import { CheckIcon, Search, Home } from "lucide-react";
import Link from "next/link";
import { genesysAuthenticatedFetch } from "@/lib/genesys/admin-client-auth";

const ALL_TYPES = ["carrier", "caller_name"];

export default function LookupForm({ accessToken }) {
  const [phone, setPhone] = useState("");
  const [types, setTypes] = useState(["carrier", "caller_name"]);
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState(null);
  const [openPayload, setOpenPayload] = useState(false);

  // Prefill from active conversation
  useEffect(() => {
    async function prefillFromConversation() {
      try {
        const convRes = await genesysAuthenticatedFetch('/api/genesys/conversations');
        const convData = await convRes.json();
        
        if (convData.entities && convData.entities.length > 0) {
          const activeConv = convData.entities[0];
          const participant = activeConv.participants?.find(p => 
            p.purpose === 'external' || p.participantType === 'External'
          );
          
          if (participant && participant.ani) {
            const ani = participant.ani.replace('tel:', '');
            setPhone(ani);
          }
        }
      } catch (error) {
        console.error('Error prefilling from conversation:', error);
      }
    }
    
    if (accessToken) {
      prefillFromConversation();
    }
  }, [accessToken]);

  const sections = useMemo(
    () => [
      { key: "carrier", label: "Carrier" },
      { key: "caller_name", label: "Caller Name" },
    ],
    []
  );

  async function onLookup() {
    setLooking(true);
    setResult(null);
    try {
      const res = await fetch('/api/number-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: phone,
          carrierLookup: types.includes('carrier'),
          callerLookup: types.includes('caller_name')
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.data) throw new Error(data?.error || "Lookup failed");
      setResult(data);
      toast.success("Lookup complete");
    } catch (err) {
      toast.error("Lookup failed", {
        description: String(err?.message || err),
      });
    } finally {
      setLooking(false);
    }
  }

  function flattenEntries(obj, prefix = "") {
    const entries = [];
    const isPrimitive = (v) =>
      v === null ||
      v === undefined ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean";
    try {
      if (isPrimitive(obj)) {
        const val = obj;
        if (val === null || val === undefined) return entries;
        const s = String(val).trim();
        if (s === "") return entries;
        entries.push({ key: prefix || "value", value: s });
        return entries;
      }
      if (Array.isArray(obj)) {
        obj.forEach((item, idx) => {
          entries.push(...flattenEntries(item, `${prefix}[${idx}]`));
        });
        return entries;
      }
      if (typeof obj === "object") {
        Object.keys(obj).forEach((k) => {
          const child = obj[k];
          const newPrefix = prefix ? `${prefix}.${k}` : k;
          if (isPrimitive(child)) {
            if (child === null || child === undefined) return;
            const s = String(child).trim();
            if (s === "") return;
            entries.push({ key: newPrefix, value: s });
          } else {
            entries.push(...flattenEntries(child, newPrefix));
          }
        });
        return entries;
      }
    } catch (_) {}
    return entries;
  }

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Search className="size-6 text-telnyx-green" /> Number Lookup
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
              <label className="text-sm">Phone (E.164)</label>
              <Input
                placeholder="+14155550123"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-sm">Lookup Types</label>
              <ToggleGroup
                type="multiple"
                value={types}
                onValueChange={(vals) => setTypes(vals.length ? vals : [])}
                variant="outline"
                className="w-full rounded-md"
              >
                {sections.map((s) => (
                  <ToggleGroupItem
                    key={s.key}
                    value={s.key}
                    className="flex-1 cursor-pointer flex items-center justify-center gap-2"
                  >
                    <span className="pointer-events-none select-none">
                      {s.label}
                    </span>
                    {types.includes(s.key) && (
                      <CheckIcon className="ml-1 text-telnyx-green" />
                    )}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <div className="flex items-right justify-end gap-3">
              <Button
                disabled={looking || !phone}
                onClick={onLookup}
                className="w-50"
              >
                {looking ? "Looking up…" : "Lookup"}
              </Button>
              <Button
                variant="outline"
                disabled={!result}
                onClick={() => setOpenPayload(true)}
              >
                View JSON
              </Button>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col items-start gap-4">
          {(() => {
            const d = result?.data || result || null;
            if (!d) return null;
            const items = flattenEntries(d);
            if (items.length === 0) return null;
            return (
              <div className="w-full">
                <div className="text-sm font-medium mb-2">Results</div>
                <div className="flex flex-wrap gap-2">
                  {items.map((it) => (
                    <Badge key={`${it.key}:${it.value}`} variant="secondary">
                      {it.key}: {it.value}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })()}
        </CardFooter>
        <Sheet
          open={!!openPayload}
          onOpenChange={(o) => !o && setOpenPayload(false)}
        >
          <SheetContent
            side="right"
            className="dark:bg-neutral-900 text-neutral-50 sm:max-w-3xl"
          >
            <SheetHeader>
              <SheetTitle>Lookup Response</SheetTitle>
            </SheetHeader>
            <div className="p-4">
              <CodeBlock
                wrap={true}
                language="json"
                data={result ?? { hint: "Run a lookup to see results here." }}
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
