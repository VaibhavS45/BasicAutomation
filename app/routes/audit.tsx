// app/routes/audit.tsx — H7e: searchable audit viewer.
// Reads .data/audit.jsonl through audit.query: full-text search + filters
// by agent/actor, tool/action, and outcome. Read-only; querying never logs.
import { useActionQuery } from "@agent-native/core/client/hooks";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  input: unknown;
  outcome: unknown;
}

export function meta() {
  return [{ title: "Audit" }];
}

export default function AuditRoute() {
  useSetPageTitle("Audit");
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [ok, setOk] = useState<"" | "true" | "false">("");
  const [applied, setApplied] = useState<{ q?: string; action?: string; actor?: string; ok?: boolean }>({});

  const query = useActionQuery("audit.query", {
    ...applied,
    limit: 50,
    offset: 0,
  });
  const payload = (query.data as { ok?: boolean; data?: { entries?: AuditEntry[]; total?: number } } | undefined)
    ?.data;
  const entries = payload?.entries ?? [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Audit</h1>
        <p className="text-sm text-muted-foreground">
          Every agent, trigger, and tool run — newest first.
          {payload ? ` ${payload.total ?? 0} matching.` : ""}
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({
            ...(q.trim() ? { q: q.trim() } : {}),
            ...(action.trim() ? { action: action.trim() } : {}),
            ...(actor.trim() ? { actor: actor.trim() } : {}),
            ...(ok === "" ? {} : { ok: ok === "true" }),
          });
        }}
      >
        <Input
          aria-label="Search audit log"
          placeholder="Search everything…"
          className="w-48"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Input
          aria-label="Filter by action"
          placeholder="action: gmail…"
          className="w-36"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
        <Input
          aria-label="Filter by actor"
          placeholder="actor…"
          className="w-32"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
        <div className="flex gap-1" role="group" aria-label="Outcome filter">
          {(["", "true", "false"] as const).map((v) => (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={ok === v ? "secondary" : "ghost"}
              onClick={() => setOk(v)}
            >
              {v === "" ? "all" : v === "true" ? "ok" : "failed"}
            </Button>
          ))}
        </div>
        <Button type="submit" size="sm">
          Search
        </Button>
      </form>
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load the audit log. Retrying…
        </p>
      ) : null}
      <ol className="flex flex-col gap-1">
        {entries.map((e, i) => {
          const failed = (e.outcome as { ok?: unknown } | null)?.ok === false;
          return (
            <li key={`${e.at}-${i}`} className="rounded-md border border-border">
              <details>
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      failed ? "bg-destructive" : "bg-emerald-500",
                    )}
                    aria-hidden="true"
                  />
                  <span className="font-mono text-muted-foreground">
                    {new Date(e.at).toLocaleString()}
                  </span>
                  <span className="truncate font-semibold">{e.action}</span>
                  <span className="truncate text-muted-foreground">{e.actor}</span>
                </summary>
                <pre className="overflow-x-auto border-t border-border bg-muted/40 p-3 font-mono text-[11px]">
                  {JSON.stringify({ input: e.input, outcome: e.outcome }, null, 2)}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
      {entries.length === 0 && !query.isPending ? (
        <p className="text-sm text-muted-foreground">No matching entries.</p>
      ) : null}
    </div>
  );
}
