"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Check, WrapText } from "lucide-react";

export default function CodeBlock({
  title,
  code,
  data,
  language = "json",
  wrap = false,
  maxHeight = 320,
  height,
  className,
}) {
  const [wrapped, setWrapped] = useState(wrap);
  const [copied, setCopied] = useState(false);

  const text = useMemo(() => {
    if (code != null) return String(code);
    if (data != null) {
      try {
        return JSON.stringify(data, null, 2);
      } catch {
        return String(data);
      }
    }
    return "";
  }, [code, data]);

  const highlightedJsonHtml = useMemo(() => {
    if (language !== "json") return null;
    try {
      const raw = text;
      if (!raw) return "";
      const safe = raw
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const tokenized = safe.replace(
        /(\"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\\"])*\"\s*:?)|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,
        (match) => {
          if (match.startsWith('"')) {
            if (/:$/.test(match)) {
              return `<span class=\"text-emerald-700 dark:text-emerald-300\">${match}</span>`;
            }
            return `<span class=\"text-orange-700 dark:text-orange-300\">${match}</span>`;
          }
          if (/^true$|^false$/.test(match)) {
            return `<span class=\"text-violet-700 dark:text-violet-300\">${match}</span>`;
          }
          if (/^null$/.test(match)) {
            return `<span class=\"text-zinc-600 dark:text-zinc-400 italic\">${match}</span>`;
          }
          return `<span class=\"text-sky-700 dark:text-sky-300\">${match}</span>`;
        }
      );
      return tokenized;
    } catch {
      return null;
    }
  }, [text, language]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div
      className={cn(
        "rounded-lg border bg-background flex flex-col",
        className
      )}
      style={height != null ? { height } : undefined}
    >
      {(title || language) && (
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-2">
            {title && <div className="text-sm font-medium">{title}</div>}
            {language && (
              <Badge variant="secondary" className="text-[10px]">
                {language}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setWrapped((v) => !v)}
              title={wrapped ? "Disable wrap" : "Wrap lines"}
            >
              <WrapText className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={handleCopy}
              title={copied ? "Copied" : "Copy"}
            >
              {copied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
          </div>
        </div>
      )}
      <div
        className={cn(
          "relative",
          height != null ? "flex-1 overflow-hidden" : undefined
        )}
      >
        <pre
          className={cn(
            "m-0 overflow-auto p-3 text-xs leading-relaxed",
            wrapped ? "whitespace-pre-wrap break-words" : "whitespace-pre"
          )}
          style={height != null ? { height: "100%" } : { maxHeight }}
        >
          {language === "json" && highlightedJsonHtml != null ? (
            <code dangerouslySetInnerHTML={{ __html: highlightedJsonHtml }} />
          ) : (
            <code>{text}</code>
          )}
        </pre>
      </div>
    </div>
  );
}
