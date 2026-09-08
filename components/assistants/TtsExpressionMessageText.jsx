"use client";

import { useMemo } from "react";
import { parseTtsExpressionText } from "@/lib/ai/tts-expression-text.mjs";
import { renderEmojiShortcodes } from "@/lib/ai/emoji-shortcodes.mjs";
import { MarkdownComponents, Response } from "@/components/ai-elements/response";
import { cn } from "@/lib/utils";

export default function TtsExpressionMessageText({
  children,
  appearance = "default",
  from = "assistant",
}) {
  const { expressionByHref, markdown } = useMemo(() => {
    const parts = parseTtsExpressionText(renderEmojiShortcodes(children));
    const expressions = new Map();
    let expressionIndex = 0;
    const nextMarkdown = parts
      .map((part) => {
        if (part.type === "text") return part.value;
        const href = `#telnyx-tts-expression-${expressionIndex++}`;
        expressions.set(href, part);
        return `[${part.label}](${href})`;
      })
      .join("");
    return { expressionByHref: expressions, markdown: nextMarkdown };
  }, [children]);

  const components = useMemo(
    () => ({
      ...MarkdownComponents,
      a({ href, children: linkChildren, className, ...props }) {
        const expression = expressionByHref.get(href);
        if (expression) {
          return (
            <span
              title={expression.raw}
              className={cn(
                "mx-0.5 inline-flex translate-y-[-1px] items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none",
                appearance === "genesys"
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-500 bg-slate-700 text-white"
              )}
            >
              {expression.label}
            </span>
          );
        }

        return (
          <a
            className={cn(
              "underline underline-offset-2",
              appearance === "genesys"
                ? from === "user"
                  ? "text-white hover:text-slate-200"
                  : "text-black hover:text-slate-700"
                : "text-sky-300 hover:text-sky-200",
              className
            )}
            href={href}
            rel="noreferrer noopener"
            target="_blank"
            {...props}
          >
            {linkChildren}
          </a>
        );
      },
    }),
    [appearance, expressionByHref, from]
  );

  return (
    <Response className="min-w-0 whitespace-pre-wrap" components={components}>
      {markdown}
    </Response>
  );
}
