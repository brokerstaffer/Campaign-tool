"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NAV, isActive, type NavItem } from "@/components/layout/nav";
import { CreditsMeter } from "@/components/layout/credits-meter";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/*
 * Collapsed by default, because this product is a wide dense table and the nav
 * is two rows. Expanding is the deliberate act; the default should be the one
 * that gives the data the most room.
 *
 * The preference is read through useSyncExternalStore rather than an effect,
 * for the same reason as column-picker.tsx: localStorage is an external store,
 * React handles the SSR snapshot and the tearing, and there is no cascading
 * render for the React Compiler lint to reject. getSnapshot must return a
 * referentially stable value — a boolean is a primitive, so no cache is needed.
 */
const STORAGE_KEY = "bs.sidebar.expanded";

function subscribe(onChange: () => void) {
  // `storage` fires for OTHER tabs, so expanding here expands there too.
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function getSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // private browsing
  }
}

const getServerSnapshot = () => false;

function useSidebarExpanded() {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Local echo so the toggle is instant rather than waiting on a storage event.
  const [override, setOverride] = useState<boolean | null>(null);

  function set(next: boolean) {
    setOverride(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* private browsing — the session still works, it just won't persist */
    }
  }

  return [override ?? stored, set] as const;
}

function NavRow({
  item,
  pathname,
  expanded,
}: {
  item: NavItem;
  pathname: string;
  expanded: boolean;
}) {
  const Icon = item.icon;
  const active = isActive(pathname, item.href);

  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md py-1.5 text-sm transition-colors",
        expanded ? "px-2.5" : "justify-center px-0",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {expanded ? <span className="truncate">{item.label}</span> : null}
    </Link>
  );

  // Collapsed, the tooltip is the only label the rail has — not decoration.
  if (expanded) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [expanded, setExpanded] = useSidebarExpanded();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r bg-card transition-[width] duration-150",
        expanded ? "w-[212px]" : "w-[56px]",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b",
          expanded ? "gap-2.5 px-4" : "justify-center px-0",
        )}
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background">
          BS
        </div>
        {expanded ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            BrokerStaffer
          </span>
        ) : null}
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2.5">
        {NAV.map((item) => (
          <NavRow
            key={item.href}
            item={item}
            pathname={pathname}
            expanded={expanded}
          />
        ))}
      </nav>

      <div className="border-t">
        {expanded ? <CreditsMeter /> : null}

        <div
          className={cn(
            "flex items-center border-t py-2.5",
            expanded ? "gap-2 px-3" : "flex-col gap-1.5 px-0",
          )}
        >
          {expanded ? (
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={email}
            >
              {email}
            </span>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
                aria-expanded={expanded}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {expanded ? (
                  <PanelLeftClose className="size-3.5" />
                ) : (
                  <PanelLeftOpen className="size-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {expanded ? "Collapse" : "Expand"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={signOut}
                aria-label="Sign out"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <LogOut className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {expanded ? "Sign out" : `Sign out — ${email}`}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}
