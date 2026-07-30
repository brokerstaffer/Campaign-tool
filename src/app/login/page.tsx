import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to continue.
          </p>
        </div>
        {/* useSearchParams() needs a Suspense boundary in the App Router. */}
        <Suspense fallback={<div className="h-56" />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
