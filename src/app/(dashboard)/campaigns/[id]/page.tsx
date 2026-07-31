import { notFound } from "next/navigation";
import { CampaignDetail } from "@/components/campaigns/campaign-detail";

export const metadata = { title: "Campaign" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Next 16: route params are a Promise.
  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId) || campaignId <= 0) notFound();

  return <CampaignDetail id={campaignId} />;
}
