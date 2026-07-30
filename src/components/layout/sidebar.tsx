"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { NAV, isActive, type NavItem } from "@/components/layout/nav";
import { CreditsMeter } from "@/components/layout/credits-meter";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function NavRow({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  const base =
    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors";

  if (item.status === "soon") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Not a link, and aria-disabled so assistive tech agrees with the
              visual affordance. There is no route behind this yet. */}
          <span
            aria-disabled="true"
            className={cn(base, "cursor-default text-muted-foreground/45")}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">Coming soon</TooltipContent>
      </Tooltip>
    );
  }

  const active = isActive(pathname, item.href);

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        base,
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside className="flex w-[212px] shrink-0 flex-col border-r bg-card">
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <div className="flex size-7 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background">
          BS
        </div>
        <span className="truncate text-sm font-medium">BrokerStaffer</span>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto p-2.5">
        {NAV.map((group, index) => (
          <div key={group.label ?? `group-${index}`} className="space-y-0.5">
            {group.label ? (
              <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
            ) : null}
            {group.items.map((item) => (
              <NavRow key={item.href} item={item} pathname={pathname} />
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t">
        <CreditsMeter />
        <div className="flex items-center gap-2 border-t px-3 py-2.5">
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={email}
          >
            {email}
          </span>
          <button
            type="button"
            onClick={signOut}
            aria-label="Sign out"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="size-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
