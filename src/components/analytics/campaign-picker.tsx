"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/*
 * A searchable single-campaign picker.
 *
 * Replaces the plain <select> that these dialogs used. A native select over 95
 * campaigns whose names all begin "Jeff Cook Real Estate LPT Realty + Nicole +
 * …" is unusable: they differ in the last few words, which is exactly the part
 * a dropdown truncates and the part type-ahead cannot reach, since native
 * type-ahead matches from the START of the option.
 *
 * Searching matches anywhere in the name, which is the same rule the campaign →
 * client matcher uses, so "Charlotte" finds the campaign whose distinguishing
 * detail is at the end.
 */

interface Campaign {
  id: number;
  name: string;
  status: string;
  lifetime_emails_sent?: number | null;
}

export function CampaignPicker({
  value,
  onChange,
  placeholder = "Choose a campaign…",
  emptyLabel,
  exclude,
  disabled,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  /** When set, an explicit "no campaign" choice is offered with this label. */
  emptyLabel?: string;
  exclude?: number | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery<{ items: Campaign[] }>({
    queryKey: ["campaigns", "all", ""],
    queryFn: async () => {
      const response = await fetch("/api/campaigns?status=all");
      if (!response.ok) throw new Error("Failed to load campaigns");
      return response.json();
    },
    enabled: open || value != null,
    staleTime: 60_000,
  });

  const campaigns = (data?.items ?? []).filter((c) => c.id !== exclude);
  const selected = campaigns.find((c) => c.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-9 w-full justify-between px-2.5 text-sm font-normal"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected?.name ?? (value == null && emptyLabel ? emptyLabel : placeholder)}
          </span>
          <ChevronsUpDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command
          // Match anywhere in the name, not just the prefix — these names differ
          // at the end, which is precisely where prefix matching gives up.
          filter={(value, search) =>
            value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <CommandInput placeholder="Search campaigns…" className="h-9 pl-7 text-sm" />
          </div>
          <CommandList>
            <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
              No campaigns match
            </CommandEmpty>
            <CommandGroup>
              {emptyLabel ? (
                <CommandItem
                  value={emptyLabel}
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="text-sm text-muted-foreground"
                >
                  <span className="mr-2 size-3.5 shrink-0" />
                  {emptyLabel}
                </CommandItem>
              ) : null}

              {campaigns.map((campaign) => (
                <CommandItem
                  key={campaign.id}
                  value={campaign.name}
                  onSelect={() => {
                    onChange(campaign.id);
                    setOpen(false);
                  }}
                  className="gap-2 text-sm"
                >
                  <Check
                    className={cn(
                      "size-3.5 shrink-0",
                      value === campaign.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{campaign.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {campaign.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
