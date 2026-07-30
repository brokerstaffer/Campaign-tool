import { ComingSoon } from "@/components/analytics/coming-soon";

export default function ClientsPage() {
  return (
    <ComingSoon
      title="Clients"
      description="Client names and aliases, the campaign-to-client mapping, and the unassigned/ambiguous queue that keeps the Clients rollup tying out to the KPI band."
      blockedOn="the client list, and the campaign names to pin the matcher against"
    />
  );
}
