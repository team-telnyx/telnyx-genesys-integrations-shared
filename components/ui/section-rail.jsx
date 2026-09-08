"use client";

import { cn } from "@/lib/utils";

export const SECTION_RAIL_WIDTH = "100px";

function RailItem({ item, activeId, onSelect }) {
  const { id, label, icon: Icon, description } = item;
  const isActive = activeId === id;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(id)}
      title={description || label}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group flex min-h-[68px] w-[84px] shrink-0 flex-col items-center justify-center rounded-[1rem] px-1 py-2 text-center transition-all duration-200 md:w-full",
        isActive
          ? "bg-foreground text-background shadow-sm"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
      )}
    >
      {Icon ? (
        <Icon
          className={cn(
            "h-[22px] w-[22px] transition",
            isActive
              ? "text-background"
              : "text-muted-foreground group-hover:text-foreground"
          )}
        />
      ) : null}
      <span className="mt-1.5 max-w-full text-wrap break-words text-[10px] font-medium leading-tight tracking-tight">
        {label}
      </span>
    </button>
  );
}

export function SectionRail({
  items = [],
  activeId,
  onSelect,
  ariaLabel = "Sections",
  className,
}) {
  return (
    <aside
      className={cn(
        "min-h-0 overflow-hidden rounded-[1.25rem] border bg-card/95 p-2 shadow-sm backdrop-blur",
        className
      )}
    >
      <nav
        className="flex h-full min-h-0 gap-2.5 overflow-x-auto md:flex-col md:items-center md:overflow-x-hidden md:overflow-y-auto"
        aria-label={ariaLabel}
      >
        {items.map((item) => (
          <RailItem
            key={item.id}
            item={item}
            activeId={activeId}
            onSelect={onSelect}
          />
        ))}
      </nav>
    </aside>
  );
}
