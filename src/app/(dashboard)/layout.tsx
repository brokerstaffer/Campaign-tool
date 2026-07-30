import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { Providers } from "@/components/providers";
import { Sidebar } from "@/components/layout/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The proxy already guarantees a valid session here; this read is only to get
  // the email for the sidebar footer, so a miss degrades to a blank label
  // rather than a redirect loop.
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );

  return (
    <Providers>
      <div className="flex h-screen w-screen overflow-hidden bg-background">
        <Sidebar email={session?.email ?? ""} />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </Providers>
  );
}
