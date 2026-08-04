import { BarChart3, CalendarClock, Mail, Users, type LucideIcon } from "lucide-react";

/*
 * Two destinations, both real.
 *
 * This file used to mirror the reference product's full sidebar with dimmed
 * "Soon" placeholders — the theory being that an omitted item reads as missing
 * while a dimmed one reads as planned. In practice seven of nine rows were
 * dead, which makes the two live ones harder to find rather than easier to
 * trust.
 *
 * Clients is back for a concrete reason, not for symmetry: two live campaigns
 * ("Kelly + Co + Nicole + BRIGHT", "Rise + Nicole + SRAR") currently match no
 * client, so their volume lands in the KPI band but in no client row. That page
 * is the only place to resolve them, and it had no way in.
 */

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export const NAV: NavItem[] = [
  { label: "Campaigns", href: "/campaigns", icon: Mail },
  // Spec §10 keeps the forecast as its own screen rather than a tab: it answers
  // "what goes out next", which is a different question from "how did it do".
  { label: "Schedule", href: "/schedule", icon: CalendarClock },
  { label: "Analytics", href: "/analytics/campaign", icon: BarChart3 },
  // Where the campaign→client mapping is maintained. Every client-grouped
  // number on the dashboard depends on it, and an unassigned campaign is only
  // fixable here.
  { label: "Clients", href: "/clients", icon: Users },
];

/** Active when the path is the item or a descendant of it. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/analytics/campaign") return pathname.startsWith("/analytics");
  return pathname === href || pathname.startsWith(`${href}/`);
}
