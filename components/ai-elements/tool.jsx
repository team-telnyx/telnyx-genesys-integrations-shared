"use client";
import { Badge } from "@/components/genesys-ai/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  XCircleIcon,
} from "lucide-react";
import { CodeBlock, CodeBlockCopyButton } from "./code-block";
import { isValidElement } from "react";

// Safely stringify arbitrary objects for display without crashing on
// circular references, DOM nodes, or React elements.
function safeStringify(value, space = 2) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(
      value,
      (key, val) => {
        if (typeof val === "function") return "[Function]";
        if (isValidElement(val)) return "[ReactElement]";
        if (typeof Element !== "undefined" && val instanceof Element)
          return `[DOM ${val.tagName}]`;
        if (typeof Window !== "undefined" && val instanceof Window)
          return "[Window]";
        if (val && typeof val === "object") {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      },
      space
    );
  } catch (_) {
    try {
      return String(value);
    } catch (_) {
      return "[Unserializable]";
    }
  }
}

export const Tool = ({ className, ...props }) => (
  <Collapsible
    className={cn("not-prose mb-4 w-full min-w-0 max-w-full overflow-hidden rounded-md border [contain:inline-size]", className)}
    {...props}
  />
);

const getStatusBadge = (status) => {
  const labels = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "output-available": "Completed",
    "output-error": "Error",
  };

  const icons = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
    "output-error": <XCircleIcon className="size-4 text-red-600" />,
  };

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
};

const TOOL_ICON_BY_NAME = [
  [/skill|skill_view|skill_manage/i, "📚"],
  [/terminal|shell|bash|zsh|command/i, "💻"],
  [/todo|task/i, "📋"],
  [/read_file|file_read|open_file/i, "📖"],
  [/write_file|patch|edit/i, "🛠️"],
  [/search_files|search|grep|find/i, "🔎"],
  [/browser|web|navigate|http/i, "🌐"],
  [/vision|image|screenshot/i, "👁️"],
  [/execute_code|python|code/i, "🐍"],
  [/git|github|pr|commit/i, "🌿"],
  [/memory|session/i, "🧠"],
  [/cron|schedule/i, "⏰"],
];

function getToolIcon(type) {
  const name = String(type || "tool");
  return TOOL_ICON_BY_NAME.find(([pattern]) => pattern.test(name))?.[1] || "🔧";
}

export const ToolHeader = ({ className, type, state, ...props }) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full min-w-0 items-center justify-between gap-4 p-3",
      className
    )}
    {...props}
  >
    <div className="flex min-w-0 items-center gap-2">
      <span className="size-4 shrink-0 text-center text-sm leading-4" aria-hidden="true">{getToolIcon(type)}</span>
      <span className="min-w-0 truncate font-medium text-sm">{type}</span>
      {getStatusBadge(state)}
    </div>
    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export const ToolContent = ({ className, ...props }) => (
  <CollapsibleContent
    className={cn(
      "min-w-0 max-w-full overflow-hidden data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in [&_*]:min-w-0",
      className
    )}
    {...props}
  />
);

export const ToolInput = ({ className, input, ...props }) => (
  <div className={cn("min-w-0 max-w-full space-y-2 overflow-hidden p-4", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="min-w-0 max-w-full overflow-hidden rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json">
        <CodeBlockCopyButton />
      </CodeBlock>
    </div>
  </div>
);

export const ToolOutput = ({ className, output, errorText, ...props }) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output}</div>;

  if (isValidElement(output)) {
    // Render React elements directly
    Output = <div>{output}</div>;
  } else if (typeof output === "object") {
    Output = (
      <CodeBlock code={safeStringify(output, 2)} language="json">
        <CodeBlockCopyButton />
      </CodeBlock>
    );
  } else if (typeof output === "string") {
    Output = (
      <CodeBlock code={output} language="json">
        <CodeBlockCopyButton />
      </CodeBlock>
    );
  }

  return (
    <div className={cn("min-w-0 max-w-full space-y-2 overflow-hidden p-4", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "min-w-0 max-w-full overflow-x-auto rounded-md text-xs [contain:inline-size] [&_pre]:!max-w-full [&_pre]:!overflow-x-auto [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
