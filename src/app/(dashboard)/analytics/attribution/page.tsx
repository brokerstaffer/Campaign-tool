import { ComingSoon } from "@/components/analytics/coming-soon";

export default function AttributionPage() {
  return (
    <ComingSoon
      title="Attribution"
      description="Conversions attributed back to the campaign that first contacted the lead — signups, meetings, visits and customers, with attributed / in-review / unattributed splits."
      blockedOn="the external outcome API contract (base URL, auth, event vocabulary)"
    />
  );
}
