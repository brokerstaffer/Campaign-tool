import { ComingSoon } from "@/components/analytics/coming-soon";

export default function InfrastructurePage() {
  return (
    <ComingSoon
      title="Infrastructure"
      description="Sends, bounces and reply rate by sending inbox, domain and provider, plus the upcoming sending forecast."
      blockedOn="the sender-email sync (v1 ships the table; this tab reads it)"
    />
  );
}
