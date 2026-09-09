import { AiConsumerSettings } from "./AiConsumerSettings";
import { useMemo, useRef, useState, useEffect } from 'react';
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  Settings2,
  ChevronDown,
} from 'lucide-react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { cn } from '../../../lib/utils';
import { ConvexClientProvider } from '../ConvexClientProvider';
import { SignInButtons } from '../SignInButtons';
import type { Doc } from '../../../../convex/_generated/dataModel';
import {
  type PipelineStep,
  PIPELINE_STEPS,
  PIPELINE_STEP_LABEL,
} from './modelCatalogUtils';

type Step = PipelineStep;
const STEPS = PIPELINE_STEPS;
const STEP_LABEL = PIPELINE_STEP_LABEL;
const STEP_LETTER: Record<Step, string> = {
  research: 'R',
  outline: 'O',
  draft: 'D',
};

type Catalog = Doc<'modelCatalog'> & { isDeprecated?: boolean; contextLength?: number };
type Assumption = Doc<'pipelineCostAssumptions'>;

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function estimate(row: Catalog, a: Assumption | undefined): number | null {
  if (!a) return null;
  const input = (a.inputTokens / 1_000_000) * row.promptPrice;
  const output = (a.outputTokens / 1_000_000) * row.completionPrice;
  const search =
    a.webSearches && row.webSearchPrice
      ? (a.webSearches / 1000) * row.webSearchPrice
      : 0;
  const runs = (a.revisions ?? 0) + 1;
  return (input + output + search) * runs;
}

function AssignStepsDropdown({
  row,
  onChange,
}: {
  row: Catalog;
  onChange: (next: Step[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);
  const label =
    row.recommendedFor.length === 0
      ? 'Steps: (none)'
      : `Steps: ${row.recommendedFor.map((s) => STEP_LABEL[s]).join(', ')}`;
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs rounded-lg px-2 py-1 bg-slate-800/60 border border-slate-700 text-slate-200 hover:border-teal-600"
      >
        {label}
        <ChevronDown className="w-3 h-3 opacity-70" />
      </button>
      {open && (
        <div className="absolute z-20 right-0 mt-1 w-44 rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-1">
          {STEPS.map((s) => {
            const eligible = row.recommendedFor.includes(s);
            const checked = row.recommendedFor.includes(s);
            return (
              <label
                key={s}
                className={cn(
                  'flex items-center gap-2 text-xs px-2 py-1.5 rounded',
                  eligible
                    ? 'cursor-pointer hover:bg-slate-800'
                    : 'cursor-not-allowed opacity-40',
                )}
              >
                <input
                  type="checkbox"
                  disabled={!eligible}
                  checked={checked}
                  onChange={() => {
                    const next = checked
                      ? row.recommendedFor.filter((x) => x !== s)
                      : [...row.recommendedFor, s];
                    onChange(next);
                  }}
                  className="accent-teal-500"
                />
                <span className="text-slate-200">{STEP_LABEL[s]}</span>
                {!eligible && (
                  <span className="ml-auto text-[10px] text-slate-500">
                    n/a
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TryButton({ modelId }: { modelId: string }) {
  return <span title={modelId} className="text-xs text-slate-400">Experiments disabled</span>;
}

function DefaultPickerRow({
  step,
  currentId,
  options,
}: {
  step: Step;
  currentId: string | null;
  options: Catalog[];
}) {
  const set = useMutation(api.catalog.queries.setDefaultForStep);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-400 w-20">{STEP_LABEL[step]}</span>
      <select
        value={currentId ?? ''}
        onChange={async (e) => {
          if (!e.target.value) return;
          try {
            await set({ step, modelId: e.target.value });
          } catch (err) {
            alert(err instanceof Error ? err.message : String(err));
          }
        }}
        className="flex-1 rounded-lg bg-slate-900 border border-slate-700 text-sm text-slate-100 px-2 py-1.5"
      >
        <option value="">— choose a model —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.displayName} ({fmtUsd(o.promptPrice)} in / {fmtUsd(o.completionPrice)} out per 1M)
          </option>
        ))}
      </select>
    </div>
  );
}

function AssumptionsEditor({
  assumptions,
}: {
  assumptions: Assumption[];
}) {
  const upsert = useMutation(api.catalog.queries.upsertAssumption);
  const byStep = new Map(assumptions.map((a) => [a.step, a]));
  const [drafts, setDrafts] = useState<
    Record<Step, { input: string; output: string; web: string; rev: string }>
  >({
    research: {
      input: String(byStep.get('research')?.inputTokens ?? 5000),
      output: String(byStep.get('research')?.outputTokens ?? 3000),
      web: String(byStep.get('research')?.webSearches ?? 5),
      rev: String(byStep.get('research')?.revisions ?? 0),
    },
    outline: {
      input: String(byStep.get('outline')?.inputTokens ?? 6000),
      output: String(byStep.get('outline')?.outputTokens ?? 2000),
      web: String(byStep.get('outline')?.webSearches ?? 0),
      rev: String(byStep.get('outline')?.revisions ?? 0),
    },
    draft: {
      input: String(byStep.get('draft')?.inputTokens ?? 10000),
      output: String(byStep.get('draft')?.outputTokens ?? 4000),
      web: String(byStep.get('draft')?.webSearches ?? 0),
      rev: String(byStep.get('draft')?.revisions ?? 1),
    },
  });
  const save = async (step: Step) => {
    const d = drafts[step];
    await upsert({
      step,
      inputTokens: Number(d.input) || 0,
      outputTokens: Number(d.output) || 0,
      webSearches: Number(d.web) || undefined,
      revisions: Number(d.rev) || undefined,
    });
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[80px_1fr_1fr_1fr_1fr_auto] gap-2 text-[11px] text-slate-400 px-1">
        <div>Step</div>
        <div>Input tok</div>
        <div>Output tok</div>
        <div>Web searches</div>
        <div>Revisions</div>
        <div></div>
      </div>
      {STEPS.map((s) => (
        <div
          key={s}
          className="grid grid-cols-[80px_1fr_1fr_1fr_1fr_auto] gap-2 items-center"
        >
          <span className="text-xs text-slate-200">{STEP_LABEL[s]}</span>
          {(['input', 'output', 'web', 'rev'] as const).map((f) => (
            <input
              key={f}
              value={drafts[s][f]}
              onChange={(e) =>
                setDrafts({
                  ...drafts,
                  [s]: { ...drafts[s], [f]: e.target.value },
                })
              }
              className="rounded bg-slate-900 border border-slate-700 text-xs text-slate-100 px-2 py-1"
            />
          ))}
          <button
            type="button"
            onClick={() => save(s)}
            className="text-xs rounded px-2 py-1 bg-teal-700 hover:bg-teal-600 text-white"
          >
            Save
          </button>
        </div>
      ))}
    </div>
  );
}

function ModelCatalogInner() {
  const currentUser = useQuery(api.users.getCurrentUser);
  const catalog: Catalog[] | undefined = useQuery(api.catalog.queries.list, {});
  const assumptions: Assumption[] | undefined = useQuery(api.catalog.queries.listAssumptions);
  const defaults = useQuery(api.catalog.queries.getDefaults);
  const setEnabled = useMutation(api.catalog.queries.setEnabled);
  const setRecommendedFor = useMutation(api.catalog.queries.setRecommendedFor);
  const runSync = useAction(api.catalog.sync.runSyncNow);

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [stepFilter, setStepFilter] = useState<Step | null>(null);
  const [enabledOnly, setEnabledOnly] = useState(false);

  const assumptionByStep = useMemo(
    () => new Map(assumptions?.map((a) => [a.step, a]) ?? []),
    [assumptions],
  );

  if (currentUser === undefined) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
      </div>
    );
  }
  if (!currentUser) {
    return (
      <div className="max-w-md mx-auto py-12 text-center">
        <p className="mb-4 text-slate-300">Sign in to manage models.</p>
        <SignInButtons />
      </div>
    );
  }
  if (!catalog || !assumptions || !defaults) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
      </div>
    );
  }

  const visible = catalog
    .filter((r) => (enabledOnly ? r.isEnabled : true))
    .filter((r) =>
      stepFilter ? r.recommendedFor.includes(stepFilter) : true,
    );

  const optionsForStep = (s: Step): Catalog[] => catalog.filter((row) => row.isEnabled && row.recommendedFor.includes(s));

  return (
    <div className="space-y-6">
      <AiConsumerSettings />
      {/* Defaults per step */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-teal-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Default model per pipeline step
            </h3>
          </div>
          <button
            type="button"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              setSyncMsg(null);
              try {
                const r = await runSync({});
                setSyncMsg(
                  `Synced: ${r.kept} kept, ${r.superseded} superseded, ${r.deprecated} deprecated (from ${r.fetched})`,
                );
              } catch (e) {
                setSyncMsg(
                  'Sync failed: ' +
                    (e instanceof Error ? e.message : String(e)),
                );
              } finally {
                setSyncing(false);
              }
            }}
            className="inline-flex items-center gap-1.5 text-xs rounded-lg px-3 py-1.5 bg-slate-800 border border-slate-700 text-slate-200 hover:border-teal-600 disabled:opacity-50"
          >
            {syncing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Sync from OpenRouter
          </button>
        </div>
        {syncMsg && (
          <div className="text-xs text-slate-400 flex items-center gap-1.5">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            {syncMsg}
          </div>
        )}
        {STEPS.map((s) => (
          <DefaultPickerRow
            key={s}
            step={s}
            currentId={defaults[s]}
            options={optionsForStep(s)}
          />
        ))}
      </div>

      {/* Assumptions */}
      <details className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-100">
          Token assumptions for cost estimates
        </summary>
        <div className="mt-3">
          <AssumptionsEditor assumptions={assumptions} />
        </div>
      </details>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-slate-400">Filter:</span>
        <button
          type="button"
          onClick={() => setStepFilter(null)}
          className={cn(
            'text-xs rounded-lg px-2.5 py-1 border',
            stepFilter === null
              ? 'bg-teal-900/40 border-teal-700 text-teal-200'
              : 'bg-slate-800 border-slate-700 text-slate-300',
          )}
        >
          All
        </button>
        {STEPS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStepFilter(s)}
            className={cn(
              'text-xs rounded-lg px-2.5 py-1 border',
              stepFilter === s
                ? 'bg-teal-900/40 border-teal-700 text-teal-200'
                : 'bg-slate-800 border-slate-700 text-slate-300',
            )}
          >
            {STEP_LABEL[s]}
          </button>
        ))}
        <label className="text-xs text-slate-300 inline-flex items-center gap-1.5 ml-2">
          <input
            type="checkbox"
            checked={enabledOnly}
            onChange={(e) => setEnabledOnly(e.target.checked)}
            className="accent-teal-500"
          />
          Enabled only
        </label>
        <span className="text-xs text-slate-500 ml-auto">
          {visible.length} of {catalog.length} models
        </span>
      </div>

      {/* Catalog table */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-900 text-slate-400 text-[11px] uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Model</th>
                <th className="text-right px-2 py-2">Input $/M</th>
                <th className="text-right px-2 py-2">Output $/M</th>
                <th className="text-right px-2 py-2">Web $/k</th>
                <th className="text-right px-2 py-2">Context</th>
                <th className="text-left px-2 py-2">Per-call (R·O·D)</th>
                <th className="text-left px-2 py-2">Assign</th>
                <th className="text-center px-2 py-2">Enabled</th>
                <th className="text-left px-2 py-2">Try</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const chips = STEPS.map((s) => ({
                  step: s,
                  est: row.recommendedFor.includes(s)
                    ? estimate(row, assumptionByStep.get(s))
                    : null,
                }));
                return (
                  <tr
                    key={row.id}
                    className={cn(
                      'border-t border-slate-800',
                      row.isDeprecated && 'opacity-50',
                    )}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-100">
                        {row.displayName}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {row.id}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {fmtUsd(row.promptPrice)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {fmtUsd(row.completionPrice)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-400">
                      {row.webSearchPrice != null
                        ? fmtUsd(row.webSearchPrice)
                        : '—'}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-400">
                      {Math.round(row.contextLength / 1000)}k
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex gap-1">
                        {chips.map((c) => (
                          <span
                            key={c.step}
                            className={cn(
                              'text-[10px] rounded px-1.5 py-0.5 border',
                              c.est == null
                                ? 'bg-slate-800/40 border-slate-800 text-slate-600'
                                : 'bg-slate-800 border-slate-700 text-slate-200',
                            )}
                            title={STEP_LABEL[c.step]}
                          >
                            {STEP_LETTER[c.step]}:{' '}
                            {c.est == null ? '—' : fmtUsd(c.est)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <AssignStepsDropdown
                        row={row}
                        onChange={(next) =>
                          setRecommendedFor({
                            id: row.id,
                            recommendedFor: next,
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={row.isEnabled}
                        onChange={(e) =>
                          setEnabled({
                            id: row.id,
                            isEnabled: e.target.checked,
                          })
                        }
                        disabled={row.isDeprecated === true}
                        className="accent-teal-500"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <TryButton modelId={row.id} />
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-8 text-center text-slate-500 text-sm"
                  >
                    No models match the current filter. Click "Sync from
                    OpenRouter" to populate the catalog.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function ModelCatalogAdminContent() {
  return (
    <ConvexClientProvider>
      <ModelCatalogInner />
    </ConvexClientProvider>
  );
}

export default ModelCatalogAdminContent;
