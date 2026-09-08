"use client"

import * as React from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

function SearchableCombobox({
  items,
  value,
  onValueChange,
  searchPlaceholder = "Filter…",
  emptyMessage = "No matching options.",
  placeholder = "Select an option",
  disabled = false,
  className,
  ariaLabel,
  showSelectedSecondary = false,
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const listRef = React.useRef(null)
  const selected = items.find((item) => item.value === value)

  const resetListScroll = React.useCallback(() => {
    if (listRef.current) listRef.current.scrollTop = 0
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = 0
      })
    })
  }, [])

  React.useEffect(() => {
    if (open) resetListScroll()
  }, [items, open, query, resetListScroll])

  function handleOpenChange(nextOpen) {
    setOpen(nextOpen)
    if (nextOpen) {
      setQuery("")
      resetListScroll()
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn("h-10 w-full justify-between px-3 font-normal", showSelectedSecondary && "h-auto min-h-10 py-2 text-left", className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.icon && <span aria-hidden="true" className="text-base leading-none">{selected.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{selected?.label || placeholder}</span>
                {selected?.badge && <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{selected.badge}</Badge>}
              </span>
              {showSelectedSecondary && selected?.secondary && <span className="block truncate text-xs text-muted-foreground">{selected.secondary}</span>}
            </span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput
            value={query}
            onValueChange={(nextQuery) => {
              setQuery(nextQuery)
              resetListScroll()
            }}
            placeholder={searchPlaceholder}
          />
          <CommandList ref={listRef}>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {items.map((item) => (
              <CommandItem
                key={item.value}
                value={item.value}
                keywords={[item.label, item.secondary, item.badge, ...(item.keywords || [])].filter(Boolean)}
                disabled={item.disabled}
                onSelect={() => {
                  onValueChange(item.value)
                  setOpen(false)
                }}
              >
                {item.icon && <span aria-hidden="true" className="text-base leading-none">{item.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{item.label}</span>
                    {item.badge && <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{item.badge}</Badge>}
                  </span>
                  {item.secondary && <span className="block truncate text-xs text-muted-foreground">{item.secondary}</span>}
                </span>
                <Check className={cn("size-4 shrink-0", value === item.value ? "opacity-100" : "opacity-0")} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { SearchableCombobox }
