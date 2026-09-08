"use client";
import { Button } from "@/components/genesys-ai/ui/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import React, { createContext, useContext, useState } from "react";
import dynamic from "next/dynamic";
// Fallback rendered when the syntax-highlighter chunk fails to load
// (stale deployment / CDN miss → server returns HTML 404 → "Unexpected token '<'")
const PlainCode = ({ children, customStyle }) => (
  <pre className="max-w-full" style={{ margin: 0, padding: "1rem", fontSize: "11px", overflowX: "auto", ...customStyle }}>
    <code className="font-mono text-xs whitespace-pre">{children}</code>
  </pre>
);

const SyntaxHighlighter = dynamic(
  () =>
    import("react-syntax-highlighter")
      .then((m) => m.Prism)
      .catch(() => PlainCode),          // chunk missing → plain pre/code fallback
  { ssr: false, loading: () => null }
);

// Error boundary: if syntax-highlighter chunk fails to load (stale deployment / CDN miss)
// fall back to a plain <pre><code> block instead of crashing the whole tree
class SyntaxErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <pre
          className={this.props.className}
          style={{ margin: 0, padding: "1rem", fontSize: "11px", overflowX: "auto", ...this.props.style }}
        >
          <code className="font-mono text-xs whitespace-pre">{this.props.code}</code>
        </pre>
      );
    }
    return this.props.children;
  }
}
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";

const CodeBlockContext = createContext({
  code: "",
});

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  maxHeight,
  ...props
}) => (
  <CodeBlockContext.Provider value={{ code }}>
    <div
      className={cn(
        "relative w-full min-w-0 max-w-full overflow-hidden rounded-md border bg-background text-foreground [contain:inline-size] [&_pre]:!max-w-full [&_pre]:!overflow-x-auto",
        className
      )}
      style={{ maxHeight }}
      {...props}
    >
      <div className="relative min-w-0 max-w-full overflow-x-auto">
        <SyntaxErrorBoundary code={code} className="max-w-full overflow-x-auto dark:hidden">
          <SyntaxHighlighter
            className="max-w-full overflow-x-auto dark:hidden"
            codeTagProps={{ className: "font-mono whitespace-pre" }}
            customStyle={{
              margin: 0, padding: "1rem",
              fontSize: "11px",
              background: "hsl(var(--background))",
              color: "hsl(var(--foreground))",
            }}
            language={language}
            lineNumberStyle={{ color: "hsl(var(--muted-foreground))", paddingRight: "1rem", minWidth: "2.5rem" }}
            showLineNumbers={showLineNumbers}
            style={oneLight}
          >
            {code}
          </SyntaxHighlighter>
        </SyntaxErrorBoundary>
        <SyntaxErrorBoundary code={code} className="hidden max-w-full overflow-x-auto dark:block">
          <SyntaxHighlighter
            className="hidden max-w-full overflow-x-auto dark:block"
            codeTagProps={{ className: "font-mono whitespace-pre" }}
            customStyle={{
              margin: 0, padding: "1rem",
              fontSize: "11px",
              background: "hsl(var(--background))",
              color: "hsl(var(--foreground))",
            }}
            language={language}
            lineNumberStyle={{ color: "hsl(var(--muted-foreground))", paddingRight: "1rem", minWidth: "2.5rem" }}
            showLineNumbers={showLineNumbers}
            style={oneDark}
          >
            {code}
          </SyntaxHighlighter>
        </SyntaxErrorBoundary>
        {children && (
          <div className="absolute top-2 right-2 flex items-center gap-2">
            {children}
          </div>
        )}
      </div>
    </div>
  </CodeBlockContext.Provider>
);

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}) => {
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator.clipboard.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn(
        "shrink-0",
        isCopied ? "text-telnyx-green" : undefined,
        className
      )}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? (
        <Icon
          size={14}
          className={isCopied ? "text-telnyx-green" : undefined}
        />
      )}
    </Button>
  );
};
