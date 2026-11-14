import { useEffect, useMemo, useState } from "react";
import type { UsageReport } from "@linkshell/wire";
import {
  compactNumber,
  fetchUsageAnalytics,
  useManagement,
  wholeNumber,
} from "../../core";
import { AgentMark, DesktopIcon } from "../../icons";
import {
  Button,
  DataTable,
  EmptyState,
  Tab,
  TabList,
  Tabs,
  Tooltip,
  type DataTableColumn,
} from "../../primitives";
import { useSystemI18n } from "./system-i18n";

type UsageDays = 1 | 7 | 30;
type UsageMetric = "tokens" | "records";
type ModelRow = UsageReport["models"][number];

export function SystemUsagePage() {
  const { tCore, ts } = useSystemI18n();
  const report = useManagement((s) => s.usageReport);
  const loading = useManagement((s) => s.usageLoading);
  const error = useManagement((s) => s.usageError);

  const [days, setDays] = useState<UsageDays>(7);
  const [agent, setAgent] = useState("all");
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [hoveredDate, setHoveredDate] = useState<string>();
  const [knownAgents, setKnownAgents] = useState<
    NonNullable<UsageReport["agents"]>
  >([]);

  useEffect(() => {
    setHoveredDate(undefined);
    void fetchUsageAnalytics(days, agent);
  }, [days, agent]);

  useEffect(() => {
    if (report?.agents && report.agents.length > 0) {
      setKnownAgents(report.agents);
    }
  }, [report]);

  const daily = useMemo(() => report?.daily ?? [], [report]);
  const empty = report ? report.totals.records === 0 : false;
  const estimatedCostUsd =
    report?.estimatedCostUsd ?? report?.totals.estimatedCostUsd ?? 0;
  const remoteTurns = report?.remoteStats?.remoteTurns ?? 0;
  const remoteApprovals = report?.remoteStats?.remoteApprovals ?? 0;

  const valueOfDay = (day: UsageReport["daily"][number]) =>
    metric === "tokens" ? day.totalTokens : day.records;

  const peak = Math.max(1, ...daily.map(valueOfDay));
  const peakDay = daily.reduce<UsageReport["daily"][number] | undefined>(
    (best, item) =>
      valueOfDay(item) > (best ? valueOfDay(best) : 0) ? item : best,
    undefined,
  );
  const activeDay =
    daily.find((d) => d.date === hoveredDate) ?? peakDay ?? daily[daily.length - 1];
  const stride = Math.max(1, Math.floor(days / 7));

  const agentLabel = (id: string) =>
    knownAgents.find((a) => a.id === id)?.label ?? id;

  const modelColumns = useMemo<DataTableColumn<ModelRow>[]>(
    () => [
      {
        id: "agent",
        header: ts("usage.colAgent"),
        sortable: true,
        sortAccessor: (row) => row.agent,
        cell: (row) => (
          <span className="ls-usage-agent-cell">
            <AgentMark agent={row.agent} size="sm" />
            <span>{agentLabel(row.agent)}</span>
          </span>
        ),
      },
      {
        id: "model",
        header: ts("usage.colModel"),
        sortable: true,
        sortAccessor: (row) => row.model,
        cell: (row) => <span title={row.model}>{row.model}</span>,
      },
      {
        id: "records",
        header: ts("usage.colRecords"),
        numeric: true,
        sortable: true,
        sortAccessor: (row) => row.records,
        cell: (row) => wholeNumber(row.records),
      },
      {
        id: "inputTokens",
        header: ts("usage.colInput"),
        numeric: true,
        sortable: true,
        sortAccessor: (row) => row.inputTokens,
        cell: (row) => (
          <span title={wholeNumber(row.inputTokens)}>
            {compactNumber(row.inputTokens)}
          </span>
        ),
      },
      {
        id: "outputTokens",
        header: ts("usage.colOutput"),
        numeric: true,
        sortable: true,
        sortAccessor: (row) => row.outputTokens,
        cell: (row) => (
          <span title={wholeNumber(row.outputTokens)}>
            {compactNumber(row.outputTokens)}
          </span>
        ),
      },
      {
        id: "cacheReadTokens",
        header: ts("usage.colCacheRead"),
        numeric: true,
        sortable: true,
        sortAccessor: (row) => row.cacheReadTokens,
        cell: (row) =>
          row.cacheReadTokens > 0 ? (
            <span title={wholeNumber(row.cacheReadTokens)}>
              {compactNumber(row.cacheReadTokens)}
            </span>
          ) : (
            ts("usage.notReported")
          ),
      },
      {
        id: "totalTokens",
        header: ts("usage.colTotal"),
        numeric: true,
        sortable: true,
        sortAccessor: (row) => row.totalTokens,
        cell: (row) => (
          <strong title={wholeNumber(row.totalTokens)}>
            {compactNumber(row.totalTokens)}
          </strong>
        ),
      },
      {
        id: "estimatedCostUsd",
        header: ts("usage.colValue"),
        numeric: true,
        sortable: true,
        sortAccessor: (row) => row.estimatedCostUsd ?? -1,
        cell: (row) =>
          row.estimatedCostUsd !== undefined
            ? `$${row.estimatedCostUsd.toFixed(2)}`
            : ts("usage.notReported"),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [knownAgents, ts],
  );

  return (
    <div className="ls-system-stack">
      <div className="ls-usage-toolbar">
        <Tabs
          value={agent}
          variant="segmented"
          onValueChange={(next) => setAgent(next)}
        >
          <TabList label={ts("usage.colAgent")}>
            <Tab value="all">{tCore("session.outlineAll")}</Tab>
            {knownAgents
              .filter((entry) => entry.status !== "no_data" || entry.id === agent)
              .map((entry) => (
                <Tab
                  key={entry.id}
                  value={entry.id}
                  icon={<AgentMark agent={entry.id} size="xs" />}
                >
                  {entry.label}
                </Tab>
              ))}
          </TabList>
        </Tabs>

        <div className="ls-system-row__controls">
          <Tabs
            value={String(days)}
            variant="segmented"
            onValueChange={(val) => setDays(Number(val) as UsageDays)}
          >
            <TabList label={ts("usage.trendTitle")}>
              <Tab value="1">{tCore("usage.days1")}</Tab>
              <Tab value="7">{tCore("usage.days7")}</Tab>
              <Tab value="30">{tCore("usage.days30")}</Tab>
            </TabList>
          </Tabs>
          <Button
            size="sm"
            variant="ghost"
            leadingIcon="refresh"
            loading={loading}
            onClick={() => void fetchUsageAnalytics(days, agent)}
          >
            {tCore("common.refresh")}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="ls-system-banner" data-tone="danger" role="alert">
          <div className="ls-system-banner__copy">
            <DesktopIcon name="alert-circle" size="sm" />
            <span>{error}</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void fetchUsageAnalytics(days, agent)}
          >
            {ts("modal.retry")}
          </Button>
        </div>
      ) : null}

      {!report && loading && !error ? (
        <div className="ls-signin-waiting" role="status">
          <DesktopIcon name="spinner" size="lg" />
          <p>{ts("usage.scanning")}</p>
        </div>
      ) : null}

      {report ? (
        <>
          {(report.warnings ?? []).length > 0 ? (
            <div className="ls-system-banner" data-tone="warning" role="status">
              <div className="ls-system-banner__copy">
                <DesktopIcon name="info" size="sm" />
                <span>{(report.warnings ?? []).join(" ")}</span>
              </div>
            </div>
          ) : null}

          <div className="ls-usage-kpis">
            <KpiCard
              label={tCore("usage.totalTokens")}
              value={empty ? "—" : compactNumber(report.totals.totalTokens)}
              unit={empty ? undefined : "Token"}
              tip={`${wholeNumber(report.totals.totalTokens)} Token · ${ts("usage.localNote")}`}
            />
            <KpiCard
              label={tCore("usage.estimatedApiValue")}
              value={empty ? "—" : `$${estimatedCostUsd.toFixed(2)}`}
              tip={tCore("usage.subscriptionReferenceNote")}
            />
            <KpiCard
              label={tCore("usage.sessions")}
              value={empty ? "—" : wholeNumber(report.totals.sessions)}
            />
            <KpiCard
              label={ts("usage.recordsLabel")}
              value={empty ? "—" : wholeNumber(report.totals.records)}
            />
            <KpiCard
              label={ts("usage.cacheShareLabel")}
              value={
                empty
                  ? "—"
                  : `${(
                      (report.totals.cacheReadTokens /
                        Math.max(1, report.totals.totalTokens)) *
                      100
                    ).toFixed(1)}%`
              }
            />
          </div>

          {empty ? (
            <div className="ls-system-card">
              <EmptyState
                compact
                icon="usage-meter"
                title={ts("usage.emptyTitle")}
                description={ts("usage.emptyDesc")}
              />
            </div>
          ) : (
            <>
              <div className="ls-usage-roi">
                <p className="ls-usage-roi__title">
                  {tCore("usage.roiSummary", {
                    days,
                    turns: wholeNumber(remoteTurns),
                    approvals: wholeNumber(remoteApprovals),
                    cost: estimatedCostUsd.toFixed(2),
                  })}
                </p>
                <p className="ls-usage-roi__note">
                  {tCore("usage.subscriptionReferenceNote")}
                </p>
              </div>

              <section
                className="ls-usage-chart-card"
                aria-label={ts("usage.trendTitle")}
              >
                <div className="ls-usage-chart-head">
                  <div className="ls-usage-chart-readout">
                    <span>{ts("usage.trendTitle")}</span>
                    {activeDay ? (
                      <>
                        <span>· {activeDay.date}</span>
                        <strong>{compactNumber(valueOfDay(activeDay))}</strong>
                      </>
                    ) : null}
                  </div>
                  <Tabs
                    value={metric}
                    variant="segmented"
                    onValueChange={(next) => setMetric(next as UsageMetric)}
                  >
                    <TabList label={ts("usage.trendTitle")}>
                      <Tab value="tokens">{ts("usage.metricTokens")}</Tab>
                      <Tab value="records">{ts("usage.metricRecords")}</Tab>
                    </TabList>
                  </Tabs>
                </div>

                {daily.length > 0 ? (
                  <div
                    className="ls-usage-svg-wrap"
                    onMouseLeave={() => setHoveredDate(undefined)}
                  >
                    <DailyBarChartSvg
                      daily={daily}
                      peak={peak}
                      stride={stride}
                      activeDate={activeDay?.date}
                      valueOf={valueOfDay}
                      onHoverDate={setHoveredDate}
                    />
                  </div>
                ) : null}
              </section>

              <section
                className="ls-system-group"
                aria-label={ts("usage.modelsTitle")}
              >
                <div className="ls-system-group__head">
                  <h3 className="ls-system-group__title">
                    {ts("usage.modelsTitle")}
                  </h3>
                  <span className="ls-system-group__meta">{report.timezone}</span>
                </div>
                <DataTable
                  compact
                  columns={modelColumns}
                  rows={report.models ?? []}
                  getRowKey={(row) => `${row.agent}:${row.model}`}
                  label={ts("usage.modelsTitle")}
                  defaultSortColumnId="totalTokens"
                  defaultSortDirection="desc"
                />
              </section>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function KpiCard({
  label,
  value,
  unit,
  tip,
}: {
  label: string;
  value: string;
  unit?: string;
  tip?: string;
}) {
  const card = (
    <div className="ls-usage-kpi" tabIndex={tip ? 0 : undefined}>
      <span className="ls-usage-kpi__label">{label}</span>
      <strong className="ls-usage-kpi__value">
        {value}
        {unit ? <small className="ls-usage-kpi__unit">{unit}</small> : null}
      </strong>
    </div>
  );
  if (!tip) return card;
  return <Tooltip content={tip}>{card}</Tooltip>;
}

function DailyBarChartSvg({
  daily,
  peak,
  stride,
  activeDate,
  valueOf,
  onHoverDate,
}: {
  daily: UsageReport["daily"];
  peak: number;
  stride: number;
  activeDate?: string;
  valueOf: (day: UsageReport["daily"][number]) => number;
  onHoverDate: (date: string) => void;
}) {
  const width = 640;
  const height = 148;
  const plotHeight = 122;
  const count = Math.max(1, daily.length);
  const slotWidth = width / count;
  const barWidth = Math.max(6, Math.min(28, slotWidth * 0.66));

  return (
    <svg
      className="ls-usage-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Daily usage chart"
    >
      <line
        x1={0}
        y1={plotHeight}
        x2={width}
        y2={plotHeight}
        stroke="var(--ls-border)"
        strokeWidth={1}
      />
      {daily.map((day, idx) => {
        const val = valueOf(day);
        const barH = val > 0 ? Math.max(3, (val / peak) * (plotHeight - 10)) : 0;
        const x = idx * slotWidth + (slotWidth - barWidth) / 2;
        const y = plotHeight - barH;
        return (
          <g
            key={day.date}
            onMouseEnter={() => onHoverDate(day.date)}
          >
            <rect
              x={idx * slotWidth}
              y={0}
              width={slotWidth}
              height={plotHeight}
              fill="transparent"
            />
            {barH > 0 ? (
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                rx={2.5}
                className="ls-usage-bar"
                data-active={activeDate === day.date ? "true" : undefined}
              />
            ) : null}
            {idx % stride === 0 ? (
              <text
                x={idx * slotWidth + slotWidth / 2}
                y={height - 6}
                textAnchor="middle"
                className="ls-usage-axis-label"
              >
                {day.date.slice(5)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
