import { BarChart3, Mail, type LucideIcon } from "lucide-react";

/*
 * Two destinations, both real.
 *
 * This file used to mirror the reference product's full sidebar with dimmed
 * "Soon" placeholders — the theory being that an omitted item reads as missing
 * while a dimmed one reads as planned. In practice seven of nine rows were
 * dead, which makes the two live ones harder to find rather than easier to
 * trust.
 *
 * NOTE: /clients is still a working page and is no longer linked from here.
 * It is where the campaign→client mapping is maintained, so it needs a way in
 * from somewhere before anyone has to fix an unassigned campaign.
 */

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export const NAV: NavItem[] = [
  { label: "Campaigns", href: "/campaigns", icon: Mail },
  { label: "Analytics", href: "/analytics/campaign", icon: BarChart3 },
];

/** Active when the path is the item or a descendant of it. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/analytics/campaign") return pathname.startsWith("/analytics");
  return pathname === href || pathname.startsWith(`${href}/`);
}
