import { PageHeader } from "../components/PageHeader";
import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { UsageReport } from "@linkshell/wire";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentMark } from "./common";
import { desktopInvoke } from "./desktop";
import { compactNumber, wholeNumber } from "./management-model";

type Days = 1 | 7 | 30;
type Metric = "tokens" | "records";

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

  const valueOf = (day: UsageReport["daily"][number]) => (metric === "tokens" ? day.totalTokens : day.records);
  const peak = Math.max(1, ...(report?.daily ?? []).map(valueOf));
  const unit = metric === "tokens" ? "Token" : "条";
  const empty = report?.totals.records === 0;
  const label = (id: string) => agents.find((entry) => entry.id === id)?.label ?? id;
  const current = agents.find((entry) => entry.id === agent);
  const hovered = report?.daily.find((day) => day.date === selected);
  const missing = agents.filter((entry) => entry.status === "no_data");
  const stride = Math.max(1, Math.floor(days / 7));

  return (
    <div className="management-usage">
      <PageHeader
        title="用量统计"
        detail="这台电脑的 Token 与模型分布"
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
            {agents.map((entry) => (
              <TabsTrigger key={entry.id} value={entry.id} title={entry.label}>
                <AgentMark agent={entry.id} />{entry.label}
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
      {error && <p className="management-note" data-tone="warning" role="alert">{error}</p>}
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
          {empty && <p className="management-hint">所选范围暂无可用数据；未上报用量不等于零消耗。</p>}
          <div className="management-facts" data-columns="4">
            <Fact label="总用量" value={compactNumber(report.totals.totalTokens)} unit="Token" title={`${wholeNumber(report.totals.totalTokens)} Token`} empty={empty} />
            <Fact label="用量记录" value={wholeNumber(report.totals.records)} unit="条" title="本地日志中的去重用量记录，并非网络请求数" empty={empty} />
            <Fact label="会话" value={wholeNumber(report.totals.sessions)} unit="个" title="所选 Agent 和时间范围内的会话" empty={empty} />
            <Fact
              label="缓存读取占比"
              value={(report.totals.cacheReadTokens / Math.max(1, report.totals.totalTokens) * 100).toFixed(1)}
              unit="%"
              title="缓存读取 Token / 总 Token，不等同于请求缓存命中率"
              empty={empty}
            />
          </div>

          <section className="management-section" aria-label="使用趋势">
            <div className="management-section-head">
              <h2>使用趋势</h2>
              <span>{current?.label ?? "全部 Agent"} · {metric === "tokens" ? "Token" : "记录（条）"}</span>
              <Tabs value={metric} onValueChange={(value) => setMetric(value as Metric)}>
                <TabsList variant="line" aria-label="趋势指标">
                  <TabsTrigger value="tokens">Token</TabsTrigger>
                  <TabsTrigger value="records">记录</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="management-chart" role="list" onMouseLeave={() => setSelected(undefined)}>
              {report.daily.map((day, index) => (
                <div
                  key={day.date}
                  role="listitem"
                  className="management-chart-day"
                  data-dimmed={selected && selected !== day.date ? "" : undefined}
                  aria-label={`${day.date} ${wholeNumber(valueOf(day))} ${unit}`}
                  title={`${day.date} · ${wholeNumber(valueOf(day))} ${unit}`}
                  onMouseEnter={() => setSelected(day.date)}
                >
                  <span className="management-chart-bar" style={{ height: `${Math.max(valueOf(day) > 0 ? 2 : 0, valueOf(day) / peak * 100)}%` }} />
                  <small>{index % stride === 0 ? day.date.slice(5) : ""}</small>
                </div>
              ))}
            </div>
            <p className="management-chart-foot">
              <span>{hovered ? `${hovered.date} · ${wholeNumber(valueOf(hovered))} ${unit}` : report.totals.totalTokens === 0 ? "暂无用量记录" : "按日汇总 · 悬停查看完整数值"}</span>
              <span>K = 千 · M = 百万 · B = 十亿</span>
            </p>
          </section>

          <section className="management-section" aria-label="模型明细">
            <div className="management-section-head">
              <h2>模型明细</h2>
              <span>{report.models.length}</span>
              <small>按 Agent / 模型汇总 · Token</small>
            </div>
            {report.models.length ? (
              <div className="management-table-wrap">
                <table className="management-table">
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col">模型</th>
                      <th scope="col">记录（条）</th>
                      <th scope="col">输入</th>
                      <th scope="col">输出</th>
                      <th scope="col">缓存读取</th>
                      <th scope="col">总 Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.models.map((entry) => (
                      <tr key={`${entry.agent}:${entry.model}`}>
                        <td><span className="management-agent"><AgentMark agent={entry.agent} />{label(entry.agent)}</span></td>
                        <td title={entry.model}>{entry.model}</td>
                        <td>{wholeNumber(entry.records)}</td>
                        <td title={wholeNumber(entry.inputTokens)}>{compactNumber(entry.inputTokens)}</td>
                        <td title={wholeNumber(entry.outputTokens)}>{compactNumber(entry.outputTokens)}</td>
                        <td title={wholeNumber(entry.cacheReadTokens)}>{compactNumber(entry.cacheReadTokens)}</td>
                        <td title={wholeNumber(entry.totalTokens)}>{compactNumber(entry.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="management-hint">所选范围暂无模型用量</p>}
          </section>

          <div className="management-footnotes">
            {agent === "all" && missing.length > 0 && <p>{missing.map((entry) => entry.label).join("、")} 暂无用量数据</p>}
            {report.warnings.map((warning) => <p key={warning} data-tone="warning">{warning}</p>)}
            {current && <p>{current.note}</p>}
            <p>{report.timezone} · 输入不含缓存 · 本地日志统计，不代表账单或剩余额度</p>
          </div>
        </>
      )}
    </div>
  );
}

function Fact({ label, value, unit, title, empty }: { label: string; value: string; unit: string; title: string; empty?: boolean }) {
  return (
    <div className="management-fact" title={title}>
      <span>{label}</span>
      <strong>{empty ? "—" : value}<small>{unit}</small></strong>
    </div>
  );
}
