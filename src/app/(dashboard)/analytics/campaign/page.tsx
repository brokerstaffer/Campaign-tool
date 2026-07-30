import { Suspense } from "react";
import { CampaignTab } from "@/components/analytics/campaign-tab";

export default function CampaignPage() {
  return (
    <Suspense fallback={null}>
      <CampaignTab />
    </Suspense>
  );
}
