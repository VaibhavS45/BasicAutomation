// app/routes/memory.tsx — H7b: plain-file memory settings view.
// Open / edit / delete DATA_DIR/memory/*.md through the memory.* actions.
// The head agent reads these at the start of a turn; appends need approval.
import {
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface MemorySummary {
  name: string;
  chars: number;
  updatedAt: string;
}

export function meta() {
  return [{ title: "Memory" }];
}

export default function MemoryRoute() {
  useSetPageTitle("Memory");
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [draft, setDraft] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const listQuery = useActionQuery("memory.list", {});
  const memories = (
    (listQuery.data as { ok?: boolean; data?: { memories?: MemorySummary[] } } | undefined)
      ?.data?.memories ?? []
  );

  const readQuery = useActionQuery(
    "memory.read",
    { name: selected ?? "" },
    { enabled: selected !== null },
  );
  const content = (
    (readQuery.data as { ok?: boolean; data?: { content?: string } } | undefined)
      ?.data?.content ?? ""
  );

  useEffect(() => {
    if (selected && selected === loadedFor) return;
    if (selected && !readQuery.isFetching && content !== undefined) {
      setDraft(content);
      setLoadedFor(selected);
    }
  }, [selected, loadedFor, readQuery.isFetching, content]);

  function afterWrite(message: string) {
    setNotice(message);
    setLoadedFor(null);
    void listQuery.refetch();
    if (selected) void readQuery.refetch();
  }

  const writeMutation = useActionMutation("memory.write");
  const deleteMutation = useActionMutation("memory.delete");

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Memory</h1>
        <p className="text-sm text-muted-foreground">
          Plain markdown files the head agent reads at the start of a turn.
          Secrets are scrubbed on every write. Writes need approval.
        </p>
      </div>
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-[12rem_1fr]">
        <div className="flex flex-col gap-1">
          {memories.map((m) => (
            <Button
              key={m.name}
              type="button"
              variant={selected === m.name ? "secondary" : "ghost"}
              size="sm"
              className={cn("justify-start", selected === m.name && "font-semibold")}
              onClick={() => {
                setSelected(m.name);
                setLoadedFor(null);
                setNewName("");
                setNotice(null);
              }}
            >
              {m.name}
            </Button>
          ))}
          {memories.length === 0 && !listQuery.isPending ? (
            <p className="text-xs text-muted-foreground">No memories yet.</p>
          ) : null}
          <div className="mt-2 flex gap-1">
            <Input
              aria-label="New memory name"
              placeholder="new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
        </div>
        <div className="flex min-h-64 flex-col gap-2">
          <textarea
            aria-label="Memory content"
            className="min-h-64 w-full rounded-md border border-border bg-card p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={selected ? "Loading…" : "Pick a memory, or type a new name."}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!selected || writeMutation.isPending}
              onClick={() => {
                const name = selected as string;
                writeMutation.mutate(
                  { name, content: draft },
                  {
                    onSuccess: () => afterWrite(`Saved ${name}.`),
                    onError: (e) => setNotice(`Save failed: ${e.message}`),
                  },
                );
              }}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!newName.trim() || writeMutation.isPending}
              onClick={() => {
                const name = newName.trim();
                writeMutation.mutate(
                  { name, content: draft },
                  {
                    onSuccess: () => {
                      setSelected(name);
                      setNewName("");
                      afterWrite(`Created ${name}.`);
                    },
                    onError: (e) => setNotice(`Create failed: ${e.message}`),
                  },
                );
              }}
            >
              Create
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={!selected || deleteMutation.isPending}
              onClick={() => {
                const name = selected as string;
                deleteMutation.mutate(
                  { name },
                  {
                    onSuccess: () => {
                      setSelected(null);
                      setDraft("");
                      afterWrite(`Deleted ${name}.`);
                    },
                    onError: (e) => setNotice(`Delete failed: ${e.message}`),
                  },
                );
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
