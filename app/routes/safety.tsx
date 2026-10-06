// app/routes/safety.tsx — H7d: budget + safety panel.
// Token caps, max concurrent workers, DRY_RUN toggle (immediate), kill
// switch, and the @browser allowed-domains list. Backed by budget.get/update.
import {
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface BudgetData {
  perRunTokenCap: number;
  dailyTokenCap: number;
  maxConcurrentWorkers: number;
  dryRun: boolean;
  killSwitch: boolean;
  allowedDomains: string[];
  dailyUsed: number;
}

export function meta() {
  return [{ title: "Safety" }];
}

export default function SafetyRoute() {
  useSetPageTitle("Safety");
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<BudgetData>>({});

  const budgetQuery = useActionQuery("budget.get", {});
  const data = (budgetQuery.data as { ok?: boolean; data?: BudgetData } | undefined)
    ?.data;
  const loaded = data && Object.keys(form).length === 0;

  useEffect(() => {
    if (loaded && data) setForm({ ...data });
  }, [loaded, data]);

  const updateMutation = useActionMutation("budget.update");

  function set<K extends keyof BudgetData>(key: K, value: BudgetData[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Budget + safety</h1>
        <p className="text-sm text-muted-foreground">
          Caps and kill switches the head agent enforces before every worker
          spawn. Saving needs approval.
          {data
            ? ` Today: ${data.dailyUsed.toLocaleString()} / ${data.dailyTokenCap.toLocaleString()} tokens.`
            : ""}
        </p>
      </div>
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {data ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="perRun">Per-run cap</Label>
              <Input
                id="perRun"
                inputMode="numeric"
                value={form.perRunTokenCap ?? ""}
                onChange={(e) => set("perRunTokenCap", Number(e.target.value))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="daily">Daily cap</Label>
              <Input
                id="daily"
                inputMode="numeric"
                value={form.dailyTokenCap ?? ""}
                onChange={(e) => set("dailyTokenCap", Number(e.target.value))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="workers">Max workers</Label>
              <Input
                id="workers"
                inputMode="numeric"
                value={form.maxConcurrentWorkers ?? ""}
                onChange={(e) => set("maxConcurrentWorkers", Number(e.target.value))}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="domains">
              Allowed domains for @browser (comma-separated, empty = any public host)
            </Label>
            <Input
              id="domains"
              placeholder="example.com, docs.example.com"
              value={(form.allowedDomains ?? []).join(", ")}
              onChange={(e) =>
                set(
                  "allowedDomains",
                  e.target.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
                )
              }
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={form.dryRun ? "secondary" : "outline"}
              aria-pressed={form.dryRun}
              onClick={() => set("dryRun", !form.dryRun)}
            >
              DRY_RUN {form.dryRun ? "ON" : "OFF"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={form.killSwitch ? "destructive" : "outline"}
              aria-pressed={form.killSwitch}
              onClick={() => set("killSwitch", !form.killSwitch)}
            >
              Kill switch {form.killSwitch ? "ON" : "OFF"}
            </Button>
          </div>
          <div>
            <Button
              type="button"
              disabled={updateMutation.isPending}
              onClick={() =>
                updateMutation.mutate(
                  {
                    perRunTokenCap: form.perRunTokenCap,
                    dailyTokenCap: form.dailyTokenCap,
                    maxConcurrentWorkers: form.maxConcurrentWorkers,
                    dryRun: form.dryRun,
                    killSwitch: form.killSwitch,
                    allowedDomains: form.allowedDomains,
                  },
                  {
                    onSuccess: () => {
                      setNotice("Saved.");
                      setForm({});
                      void budgetQuery.refetch();
                    },
                    onError: (e) => setNotice(`Save failed: ${e.message}`),
                  },
                )
              }
            >
              Save policy
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}
