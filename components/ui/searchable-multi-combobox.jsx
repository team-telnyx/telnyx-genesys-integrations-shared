"use client"

import * as React from "react"
import { ChevronsUpDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

function SearchableMultiCombobox({
  items,
  value = [],
  onValueChange,
  searchPlaceholder = "Filter…",
  emptyMessage = "No matching options.",
  placeholder = "Select options",
  selectedSuffix = "selected",
  disabled = false,
  className,
  ariaLabel,
  strictFilter = false,
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const listRef = React.useRef(null)
  const selected = new Set(value)

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
  }, [open, query, resetListScroll])

  function handleOpenChange(nextOpen) {
    setOpen(nextOpen)
    if (nextOpen) {
      setQuery("")
      resetListScroll()
    }
  }

  function toggle(itemValue) {
    onValueChange(selected.has(itemValue)
      ? value.filter((entry) => entry !== itemValue)
      : [...value, itemValue])
  }

  const buttonLabel = value.length
    ? `${value.length} ${selectedSuffix}`
    : placeholder

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
          className={cn("h-10 w-full justify-between px-3 font-normal", className)}
        >
          <span className="truncate">{buttonLabel}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command
          filter={strictFilter
            ? (itemValue, search, keywords = []) => {
                const needle = search.trim().toLocaleLowerCase()
                if (!needle) return 1
                return [itemValue, ...keywords]
                  .filter(Boolean)
                  .some((candidate) => String(candidate).toLocaleLowerCase().includes(needle))
                  ? 1
                  : 0
              }
            : undefined}
        >
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
                keywords={[item.label, item.secondary, ...(item.keywords || [])].filter(Boolean)}
                onSelect={() => toggle(item.value)}
              >
                <Checkbox
                  checked={selected.has(item.value)}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="pointer-events-none"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.label}</span>
                  {item.secondary && <span className="block truncate text-xs text-muted-foreground">{item.secondary}</span>}
                </span>
              </CommandItem>
            ))}
          </CommandList>
          <div className="flex items-center justify-between gap-3 border-t p-2">
            <span className="px-1 text-xs text-muted-foreground">{value.length} {selectedSuffix}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Done</Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { SearchableMultiCombobox }
