import { Construction } from "lucide-react";

/**
 * Placeholder for the three tabs that ship after v1.
 *
 * Says what will be here and what it's waiting on, rather than a bare
 * "Coming soon" — a tab that explains itself is a roadmap; one that doesn't is
 * a dead end.
 */
export function ComingSoon({
  title,
  description,
  blockedOn,
}: {
  title: string;
  description: string;
  blockedOn?: string;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-12">
      <div className="max-w-sm text-center">
        <Construction className="mx-auto mb-3 size-6 text-muted-foreground/50" />
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1.5 text-xs text-muted-foreground">{description}</p>
        {blockedOn ? (
          <p className="mt-3 text-[11px] text-muted-foreground/70">
            Waiting on: {blockedOn}
          </p>
        ) : null}
      </div>
    </div>
  );
}
