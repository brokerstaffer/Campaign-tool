"use client";

import { useState } from "react";
import { Shuffle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "./segmented";
import {
  countVariations,
  htmlToPlainText,
  rollSpintax,
} from "@/lib/spintax.ts";

/*
 * The inline email panel shown when a step is expanded.
 *
 *   Preview — spintax rolled, HTML rendered: what one recipient actually gets.
 *   Spintax — the raw source with every group highlighted, so you can see the
 *             choices rather than one sample of them.
 *
 * Shuffle re-rolls with a new seed. The seed lives in state (not a bare
 * Math.random() at render time) so Preview is stable while you read it and
 * only changes when you ask.
 */
export function EmailPanel({
  subject,
  body,
}: {
  subject: string | null;
  body: string | null;
}) {
  const [view, setView] = useState<"preview" | "spintax">("preview");
  const [seed, setSeed] = useState(1);

  if (!body) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
        No email body stored for this step.
      </div>
    );
  }

  const variations = countVariations(body);
  const rolled = rollSpintax(body, seed);

  return (
    <div className="rounded-md border bg-background">
      <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
        <Segmented
          aria-label="Email view"
          value={view}
          onValueChange={setView}
          options={[
            { value: "preview", label: "Preview" },
            { value: "spintax", label: "Spintax" },
          ]}
        />

        {view === "preview" && variations > 1 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setSeed((s) => s + 1)}
          >
            <Shuffle className="size-3.5" />
            Shuffle
          </Button>
        ) : null}

        <span className="ml-auto text-[11px] text-muted-foreground/70">
          {variations > 1
            ? `${variations.toLocaleString()} variations`
            : "no spintax"}
          {" · "}
          {/* Merge tags are NOT substituted here — they render literally at
              send time, and pretending otherwise would misrepresent the copy. */}
          {"{FIRST_NAME}"} fills in at send time
        </span>
      </div>

      {subject ? (
        <p className="border-b px-3 py-2 text-xs">
          <span className="text-muted-foreground">Subject: </span>
          <span className="font-medium">
            {view === "preview" ? rollSpintax(subject, seed) : subject}
          </span>
        </p>
      ) : null}

      <div className="max-h-[420px] overflow-y-auto p-4">
        {view === "preview" ? (
          <div
            className="prose prose-sm max-w-none text-sm [&_a]:text-primary [&_a]:underline [&_img]:max-w-full"
            // Bodies come from EmailBison, authored by the operator. Same trust
            // boundary as the sequence editor they were written in.
            dangerouslySetInnerHTML={{ __html: rolled }}
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
            {highlightSpintax(htmlToPlainText(body))}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Renders `{a|b}` groups with a tint so the choices are visible at a glance. */
function highlightSpintax(text: string) {
  const parts = text.split(/(\{[^{}]*\|[^{}]*\})/g);
  return parts.map((part, i) =>
    /^\{[^{}]*\|[^{}]*\}$/.test(part) ? (
      <mark
        key={i}
        className="rounded bg-primary/10 px-0.5 text-primary"
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
