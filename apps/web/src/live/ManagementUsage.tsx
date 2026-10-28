import { PageHeader } from "../components/PageHeader";
import { useEffect, useState, type ReactNode } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { UsageReport } from "@linkshell/wire";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentMarks } from "../../../client/src/theme/agent-marks";
import { desktopInvoke, THIS_COMPUTER_SPACED } from "./desktop";
import { compactNumber, wholeNumber } from "./management-model";

type Days = 1 | 7 | 30;
type Metric = "tokens" | "records";
type Day = UsageReport["daily"][number];

const TIP_DELAY_MS = 300;

/**
 * An agent's mark without its tile, so it sits in a table cell or a tab as a glyph on any
 * surface. Marks drawn in one colour for their own dark or light tile become a mask the text
 * colour fills, so they follow the theme; marks with their own colours keep them.
 */
const glyphs = new Map<string, { src: string; mono: boolean } | null>();
function glyphOf(agent: string) {
  const id = agent.toLowerCase();
  if (!glyphs.has(id)) {
    const mark = agentMarks[id];
    // A complete app icon draws its tile first.
    const svg = mark && (mark.full ? mark.svg.replace(/<path[^>]*><\/path>/, "") : mark.svg);
    glyphs.set(id, svg ? {
      src: `data:image/svg+xml,${encodeURIComponent(svg)}`,
      mono: svg.includes("currentColor") || (mark.full && !svg.includes("url(#")),
    } : null);
  }
  return glyphs.get(id);
}

function AgentGlyph({ agent }: { agent: string }) {
  const glyph = glyphOf(agent);
  if (!glyph) return <span className="management-agent-glyph" data-letter="" aria-hidden>{agent.slice(0, 1).toUpperCase()}</span>;
  if (!glyph.mono) return <img className="management-agent-glyph" src={glyph.src} alt="" aria-hidden />;
  const mask = `url("${glyph.src}")`;
  return <span className="management-agent-glyph" data-mono="" style={{ WebkitMaskImage: mask, maskImage: mask }} aria-hidden />;
}

/** A label whose fine print (time zone, what a number leaves out) waits in a tooltip. */
function Tip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return (
    <Tooltip delayDuration={TIP_DELAY_MS}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="flex-col items-start">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** The usage page: a port of LinkShell.app's DesktopUsageView, over the Host's `usage.summary`. */
export function ManagementUsage() {
  const [days, setDays] = useState<Days>(7);
  const [agent, setAgent] = useState("all");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [report, setReport] = useState<UsageReport>();
  const [agents, setAgents] = useState<NonNullable<UsageReport["agents"]>>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(undefined); setReport(undefined); setSelected(undefined);
    desktopInvoke<UsageReport>("usage", { days, agent }).then((next) => {
      if (!alive) return;
      setReport(next);
      setAgents(next.agents ?? []);
    }, (failure: unknown) => {
      if (alive) setError(`无法读取用量，请确认后台服务已启动且为新版：${failure instanceof Error ? failure.message : String(failure)}`);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days, agent, revision]);

  const valueOf = (day: Day) => (metric === "tokens" ? day.totalTokens : day.records);
  const daily = report?.daily ?? [];
  const peak = Math.max(1, ...daily.map(valueOf));
  const peakDay = daily.reduce<Day | undefined>((best, day) => (valueOf(day) > (best ? valueOf(best) : 0) ? day : best), undefined);
  const unit = metric === "tokens" ? "Token" : "条记录";
  const empty = report?.totals.records === 0;
  const label = (id: string) => agents.find((entry) => entry.id === id)?.label ?? id;
  const current = agents.find((entry) => entry.id === agent);
  const missing = agents.filter((entry) => entry.status === "no_data");
  const counted = agents.filter((entry) => entry.status === "available");
  const stride = Math.max(1, Math.floor(days / 7));
  // The value said in the chart: the day under the pointer, else the highest day.
  const shown = daily.find((day) => day.date === selected) ?? peakDay;

  return (
    <div className="management-usage">
      <PageHeader
        title="用量统计"
        detail={`${THIS_COMPUTER_SPACED}的 Token 与模型分布`}
        actions={<>
          {loading && <LoaderCircle className="animate-spin management-muted" size={16} aria-label="正在读取" />}
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw />同步
          </Button>
        </>}
      />
      <div className="management-usage-filters">
        <Tabs value={agent} onValueChange={setAgent}>
          <TabsList variant="line" aria-label="Agent">
            <TabsTrigger value="all">全部</TabsTrigger>
            {/* Agents with nothing recorded (not installed, or never used) are named in 总用量's tooltip instead. */}
            {agents.filter((entry) => entry.status !== "no_data" || entry.id === agent).map((entry) => (
              <TabsTrigger key={entry.id} value={entry.id} title={entry.label}>
                <AgentGlyph agent={entry.id} />{entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Tabs value={String(days)} onValueChange={(value) => setDays(Number(value) as Days)}>
          <TabsList variant="line" aria-label="时间范围">
            <TabsTrigger value="1">今天</TabsTrigger>
            <TabsTrigger value="7">7 天</TabsTrigger>
            <TabsTrigger value="30">30 天</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {error && <p className="management-footnote" data-tone="warning" role="alert">{error}</p>}
      {/* Reading the logs can take seconds: the page's shape stands in until the numbers arrive. */}
      {!report && !error && (
        <div className="management-usage-skeleton" role="status" aria-label="正在读取用量">
          <div className="management-facts">
            {[0, 1, 2, 3].map((key) => (
              <div className="management-fact" key={key}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-6 w-24" />
              </div>
            ))}
          </div>
          <Skeleton className="h-[180px] w-full rounded-2xl" />
          <Skeleton className="h-[140px] w-full rounded-2xl" />
        </div>
      )}
      {report && (
        <>
          {report.warnings.length > 0 && (
            <div className="management-rows">
              <div className="management-row management-usage-warning" role="status">
                <span className="management-status" data-tone="warning"><span aria-hidden /></span>
                <span className="management-selectable">{report.warnings.join(" ")}</span>
                <Popover>
                  <PopoverTrigger asChild><Button variant="ghost" size="sm">查看</Button></PopoverTrigger>
                  <PopoverContent align="end">
                    <div className="management-popover">
                      {report.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                      <p>统计的来源：</p>
                      <ul>{counted.map((entry) => <li key={entry.id}>{entry.label}：{entry.note}</li>)}</ul>
                      <p>本地日志统计，不代表账单或剩余额度。</p>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          )}
          {empty && <p className="management-footnote">所选范围暂无可用数据；未上报用量不等于零消耗。</p>}
          <div className="management-facts">
            <Fact
              label="总用量"
              value={compactNumber(report.totals.totalTokens)}
              unit="Token"
              empty={empty}
              tip={<>
                <span>{wholeNumber(report.totals.totalTokens)} Token</span>
                {current ? <span>{current.label}：{current.note}</span>
                  : missing.length > 0 && <span>{missing.map((entry) => entry.label).join("、")} 暂无用量数据</span>}
                <span>本地日志统计，不代表账单或剩余额度</span>
              </>}
            />
            <Fact label="用量记录" value={wholeNumber(report.totals.records)} empty={empty} tip="本地日志中的去重用量记录，并非网络请求数" />
            <Fact label="会话" value={wholeNumber(report.totals.sessions)} empty={empty} tip="所选 Agent 和时间范围内的会话" />
            <Fact
              label="缓存读取占比"
              value={`${(report.totals.cacheReadTokens / Math.max(1, report.totals.totalTokens) * 100).toFixed(1)}%`}
              empty={empty}
              tip="缓存读取 Token / 总 Token，不等同于请求缓存命中率"
            />
          </div>

          <section className="management-section" aria-label="使用趋势">
            <div className="management-section-head">
              <Tip tip={`按 ${report.timezone} 的日期汇总`}><h2 tabIndex={0}>使用趋势</h2></Tip>
              <Tabs value={metric} onValueChange={(value) => setMetric(value as Metric)}>
                <TabsList variant="line" aria-label="趋势指标">
                  <TabsTrigger value="tokens">Token</TabsTrigger>
                  <TabsTrigger value="records">记录</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="management-chart" role="list" onMouseLeave={() => setSelected(undefined)}>
              {daily.map((day, index) => {
                const value = valueOf(day);
                const height = value > 0 ? Math.max(2, value / peak * 100) : 0;
                return (
                  <div
                    key={day.date}
                    role="listitem"
                    className="management-chart-day"
                    data-active={selected === day.date || undefined}
                    aria-label={`${day.date} ${wholeNumber(value)} ${unit}`}
                    onMouseEnter={() => setSelected(day.date)}
                  >
                    <div className="management-chart-plot">
                      <span className="management-chart-bar" style={{ height: `${height}%` }} />
                      {shown === day && value > 0 && (
                        <span className="management-chart-value" style={{ bottom: `${height}%` }}>{compactNumber(value)}</span>
                      )}
                    </div>
                    <small>{index % stride === 0 ? day.date.slice(5) : ""}</small>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="management-section" aria-label="模型明细">
            <div className="management-section-head"><h2>模型明细</h2></div>
            {report.models.length ? (
              <div className="management-table-wrap">
                <table className="management-table">
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col">模型</th>
                      <th scope="col">记录</th>
                      <th scope="col"><Tip tip="不含缓存读取与写入"><span tabIndex={0}>输入</span></Tip></th>
                      <th scope="col">输出</th>
                      <th scope="col">缓存读取</th>
                      <th scope="col">总 Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.models.map((entry) => (
                      <tr key={`${entry.agent}:${entry.model}`}>
                        <td><span className="management-agent"><AgentGlyph agent={entry.agent} />{label(entry.agent)}</span></td>
                        <td title={entry.model}>{entry.model}</td>
                        <td>{wholeNumber(entry.records)}</td>
                        <td title={wholeNumber(entry.inputTokens)}>{compactNumber(entry.inputTokens)}</td>
                        <td title={wholeNumber(entry.outputTokens)}>{compactNumber(entry.outputTokens)}</td>
                        {/* Agents that don't report cache reads count them as 0: a dash says "not known". */}
                        <td title={entry.cacheReadTokens ? wholeNumber(entry.cacheReadTokens) : "未上报"}>{entry.cacheReadTokens ? compactNumber(entry.cacheReadTokens) : "—"}</td>
                        <td title={wholeNumber(entry.totalTokens)}>{compactNumber(entry.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="management-footnote">所选范围暂无模型用量</p>}
          </section>
        </>
      )}
    </div>
  );
}

function Fact({ label, value, unit, tip, empty }: { label: string; value: string; unit?: string; tip: ReactNode; empty?: boolean }) {
  return (
    <Tip tip={tip}>
      <div className="management-fact" tabIndex={0}>
        <span>{label}</span>
        <strong>{empty ? "—" : value}{unit && !empty && <small>{unit}</small>}</strong>
      </div>
    </Tip>
  );
}
