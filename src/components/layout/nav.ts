import {
  BarChart3,
  Ban,
  Crosshair,
  Database,
  Inbox,
  Mail,
  MessageSquareReply,
  Plug,
  Users,
  type LucideIcon,
} from "lucide-react";

/*
 * The nav mirrors the reference product so the shape is familiar, but only the
 * routes that exist are navigable.
 *
 * `status: "soon"` items render as dimmed, non-interactive labels rather than
 * being omitted. An omitted item reads as *missing*; a dimmed one with a Soon
 * chip reads as *planned* — and these screenshots are the contract with the
 * client. Critically they are NOT links and there are NO stub pages: a route
 * that resolves to an empty shell is worse than a label that doesn't navigate.
 */

export type NavStatus = "live" | "soon";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  status: NavStatus;
}

export interface NavGroup {
  /** Section heading. `null` renders the items flush, with no label. */
  label: string | null;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      { label: "Inbox", href: "/inbox", icon: Inbox, status: "soon" },
      { label: "Campaigns", href: "/campaigns", icon: Mail, status: "soon" },
    ],
  },
  {
    label: "Insights",
    items: [
      {
        label: "Analytics",
        href: "/analytics/campaign",
        icon: BarChart3,
        status: "live",
      },
      {
        label: "Attribution",
        href: "/analytics/attribution",
        icon: Crosshair,
        status: "soon",
      },
    ],
  },
  {
    label: "Manage",
    items: [
      // The reference calls this "Teams". With a single EmailBison workspace
      // that label describes a constant — client is the real grouping axis.
      { label: "Clients", href: "/clients", icon: Users, status: "live" },
      { label: "Lead DB", href: "/leads", icon: Database, status: "soon" },
    ],
  },
  {
    label: "System",
    items: [
      {
        label: "Responders",
        href: "/responders",
        icon: MessageSquareReply,
        status: "soon",
      },
      { label: "Blacklist", href: "/blacklist", icon: Ban, status: "soon" },
      {
        label: "Integrations",
        href: "/integrations",
        icon: Plug,
        status: "soon",
      },
    ],
  },
];

/** Active when the path is the item or a descendant of it. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/analytics/campaign") return pathname.startsWith("/analytics");
  return pathname === href || pathname.startsWith(`${href}/`);
}
