import { useEffect, useState, type ReactNode } from "react";
import { PageHeader } from "../components/PageHeader";
import { useStore } from "zustand";
import {
  ArrowLeft,
  ChartColumn,
  CircleAlert,
  CircleArrowDown,
  Ellipsis,
  FolderOpen,
  House,
  LoaderCircle,
  Lock,
  LockOpen,
  RefreshCw,
  ScrollText,
  Settings,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import { PRO_CODE_SHOP_URL } from "@linkshell/client-core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { desktopInvoke, openDesktopExternal, setDesktopAppearance } from "./desktop";
import {
  accountAction,
  cancelLogin,
  checkUpdates,
  clearPasswordMessage,
  healthy as isHealthy,
  installCommand,
  installUpdate,
  login,
  management,
  upgradeInstall,
  newVersion as hasNewVersion,
  openLoginItems,
  openSetup,
  pollManagement,
  readLog,
  redeemPro,
  refreshAccount,
  refreshManagement,
  serviceAction,
  setAccessPassword,
  setDesktopSetting,
  setLaunchAtLogin,
  standalone as isStandalone,
  type ManagementState,
} from "./management-store";
import {
  MANAGE_PAGES,
  gatewayLabel,
  managePageTitles,
  membershipOf,
  serviceLabel,
  sourceLabel,
  type ManagePage,
} from "./management-model";
import { ManagementPairing } from "./ManagementPairing";
import { ManagementUsage } from "./ManagementUsage";
import "../styles/management.css";

type Confirm = "stop" | "restart" | "logout" | "connect-gateway" | "remove-password" | "upgrade";
type Appearance = "system" | "light" | "dark";

const pageIcons: Record<ManagePage, LucideIcon> = {
  overview: House, devices: Smartphone, password: Lock, usage: ChartColumn, log: ScrollText, updates: CircleArrowDown, settings: Settings,
};
const confirmCopy: Record<Confirm, { title: string; detail: string; action: string }> = {
  stop: { title: "停止本机服务？", detail: "正在执行的代理任务、终端与远程连接可能中断。会话记录和配对信息会保留。", action: "停止" },
  restart: { title: "重启本机服务？", detail: "正在执行的代理任务、终端与远程连接可能中断。会话记录和配对信息会保留。", action: "重启" },
  logout: { title: "退出当前账号？", detail: "当前电脑将退出账号，账号关联的远程连接可能断开。本机会话和配对记录会保留。", action: "退出登录" },
  "connect-gateway": { title: "连接官方网关？", detail: "将切换到官方网关，手机登录同一账号即可发现这台 Mac。官方网关需要 Pro，现有远程连接可能断开。", action: "连接" },
  "remove-password": { title: "移除访问密码？", detail: "其他设备将可以直接打开这台 Mac，不再需要输入密码。", action: "移除" },
  upgrade: { title: "安装更新？", detail: "将运行 linkshell upgrade 更新 CLI 和 Host。正在执行的代理任务、终端与远程连接可能中断。", action: "安装" },
};
const subtitles: Record<ManagePage, string> = {
  overview: "",
  devices: "",
  password: "",
  usage: "这台电脑的 Token 用量与模型分布",
  log: "最近 64 KB · 每 5 秒刷新",
  updates: "",
  settings: "",
};

/** Derived facts every page reads, computed once per render. */
function useFacts() {
  const state = useStore(management);
  const healthy = isHealthy(state);
  return {
    state,
    healthy,
    standalone: isStandalone(state),
    newVersion: hasNewVersion(state),
    service: serviceLabel(state.snapshot, state.problem),
    gateway: gatewayLabel(state.snapshot, healthy),
    devices: state.snapshot?.gateway?.devices ?? [],
    signedIn: state.snapshot?.account?.state === "signed-in",
    home: state.snapshot?.home ?? state.about?.home ?? "~/.linkshell",
  };
}
type Facts = ReturnType<typeof useFacts>;

function useAppearance(): [Appearance, (value: Appearance) => void] {
  const read = (): Appearance => {
    const value = (window as Window & { __LINKSHELL_DESKTOP_APPEARANCE__?: unknown }).__LINKSHELL_DESKTOP_APPEARANCE__;
    return value === "light" || value === "dark" || value === "system" ? value : "dark";
  };
  const [appearance, setAppearance] = useState(read);
  useEffect(() => {
    const receive = () => setAppearance(read());
    window.addEventListener("linkshell-desktop-appearance", receive);
    return () => window.removeEventListener("linkshell-desktop-appearance", receive);
  }, []);
  return [appearance, (value) => { setAppearance(value); setDesktopAppearance(value); }];
}

/** 本机管理: LinkShell.app's native dashboard, now a page of the Electron window. */
export function Management({ page, navigate }: { page: ManagePage; navigate: (page: ManagePage) => void }) {
  const facts = useFacts();
  const { state } = facts;
  const [confirm, setConfirm] = useState<Confirm>();
  useEffect(pollManagement, []);
  useEffect(() => {
    if (page !== "log") return;
    void readLog();
    const timer = setInterval(() => void readLog(), 5_000);
    return () => clearInterval(timer);
  }, [page]);

  const run = (action: Confirm) => {
    if (action === "remove-password") void setAccessPassword(null);
    else if (action === "logout" || action === "connect-gateway") void accountAction(action);
    else if (action === "upgrade") void upgradeInstall();
    else void serviceAction(action);
  };
  const machine = state.snapshot?.machine?.hostname.replace(/\.local$/, "");

  return (
    <div className="management">
      <div className="management-content">
        <div className="management-page">
          {page !== "usage" && (
            <PageHeader
              title={page === "overview" ? (machine ?? "这台 Mac") : managePageTitles[page]}
              detail={page === "overview" ? `本机服务${facts.service} · 网关${facts.gateway}` : subtitles[page] || undefined}
              actions={<>
                {state.busy && <LoaderCircle className="animate-spin management-muted" size={16} aria-label="正在处理" />}
                {page === "log" && <LogActions />}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" disabled={state.busy} aria-label="服务操作"><Ellipsis />本机服务</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={refreshManagement}><RefreshCw />刷新状态</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={facts.healthy} onSelect={() => void serviceAction("start")}>启动服务</DropdownMenuItem>
                    <DropdownMenuItem disabled={!facts.healthy} onSelect={() => setConfirm("restart")}>重启服务…</DropdownMenuItem>
                    <DropdownMenuItem disabled={!facts.healthy} onSelect={() => setConfirm("stop")}>停止服务…</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>}
            />
          )}
          {state.problem && (
            <Alert variant="warning" className="management-problem">
              <CircleAlert />
              <AlertDescription>
                <span className="management-selectable">{state.problem}</span>
                <Button variant="outline" size="sm" onClick={refreshManagement}>重试</Button>
              </AlertDescription>
            </Alert>
          )}
          {page === "overview" && <Overview facts={facts} confirm={setConfirm} navigate={navigate} />}
          {page === "devices" && <Devices facts={facts} />}
          {page === "password" && <Password facts={facts} confirm={setConfirm} />}
          {page === "usage" && <ManagementUsage />}
          {page === "log" && <Log facts={facts} />}
          {page === "updates" && <Updates facts={facts} confirm={setConfirm} />}
          {page === "settings" && <SettingsPage facts={facts} />}
        </div>
      </div>
      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(undefined); }}>
        {confirm && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmCopy[confirm].title}</AlertDialogTitle>
              <AlertDialogDescription>{confirmCopy[confirm].detail}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => run(confirm)}>{confirmCopy[confirm].action}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}

function Group({ title, trailing, children }: { title: string; trailing?: string; children: ReactNode }) {
  return (
    <section className="management-group" aria-label={title}>
      <h2 className="management-group-title">{title}{trailing && <span>{trailing}</span>}</h2>
      {children}
    </section>
  );
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  return <div className="management-row"><span>{title}</span><div>{children}</div></div>;
}

function Status({ text, tone }: { text: string; tone?: "success" | "warning" }) {
  return <span className="management-status" data-tone={tone}><span aria-hidden />{text}</span>;
}

function Overview({ facts, confirm, navigate }: { facts: Facts; confirm: (action: Confirm) => void; navigate: (page: ManagePage) => void }) {
  const { state, healthy, devices } = facts;
  const gateway = state.snapshot?.gateway;
  const permissions = state.permissions;
  const screenReady = permissions.recording && permissions.control;
  const external = facts.standalone && healthy && !!state.about?.bundle && state.snapshot?.hostOwner !== state.about.bundle;
  return (
    <>
      <Account facts={facts} confirm={confirm} />
      {state.snapshot?.status === "stopped" && (
        <div className="management-banner">
          <span>启动后台服务后，即可从手机连接这台 Mac。</span>
          <Button disabled={state.busy} onClick={() => void serviceAction("start")}>启动服务</Button>
        </div>
      )}
      {external && (
        <div className="management-banner" data-tone="warning">
          <span>当前服务由另一套 CLI 启动</span>
          <Button variant="outline" disabled={state.busy} onClick={() => confirm("restart")}>切换到 App 内置服务…</Button>
        </div>
      )}
      <Group title="这台 Mac 的状态">
        <div className="management-facts" data-columns="4">
          <Fact label="本机服务" value={facts.service} tone={healthy ? undefined : "warning"} caption={healthy ? "手机和工作台随时可以连接" : "启动后，即可从手机连接这台 Mac"}>
            {!healthy && state.snapshot?.status === "stopped" && <Button size="sm" disabled={state.busy} onClick={() => void serviceAction("start")}>启动</Button>}
          </Fact>
          <Fact
            label="网关"
            value={facts.gateway}
            caption={gateway?.error?.message ?? (gateway?.status === "online" ? "不在同一网络也能连上" : "只能在同一网络内连接")}
            tone={healthy && gateway?.status === "online" ? undefined : "muted"}
          />
          <Fact
            label="屏幕与控制"
            value={!permissions.known ? "检查中" : screenReady ? "已就绪" : "需要授权"}
            caption={screenReady ? "可以从手机查看和操作屏幕" : "需要录屏与辅助功能两项权限"}
            tone={!permissions.known || screenReady ? undefined : "warning"}
          >
            {permissions.known && !screenReady && <Button size="sm" variant="outline" onClick={openSetup}>授权</Button>}
          </Fact>
          <Fact
            label="已配对设备"
            value={String(devices.length)}
            unit="台"
            caption={devices.length ? `${devices.filter((device) => device.online).length} 台在线` : "扫码配对手机，或用同一账号登录"}
          >
            <Button size="sm" variant="outline" onClick={() => navigate("devices")}>管理设备</Button>
          </Fact>
        </div>
      </Group>
      <Group title="最近活动" trailing={state.activity.length ? `最近 ${Math.min(5, state.activity.length)} 条` : undefined}>
        <div className="management-rows">
          {!state.activity.length && <Empty title="尚无活动" detail="连接服务后，状态变化会显示在这里。" />}
          {state.activity.slice(0, 5).map((event) => (
            <div className="management-activity" key={`${event.at}:${event.text}`}>
              <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
              <span>{event.text}</span>
            </div>
          ))}
        </div>
      </Group>
    </>
  );
}

function Fact({ label, value, unit, caption, tone, children }: { label: string; value: string; unit?: string; caption: string; tone?: "warning" | "muted"; children?: ReactNode }) {
  return (
    <div className="management-fact">
      <span>{label}</span>
      <strong data-tone={tone}>{value}{unit && <small>{unit}</small>}</strong>
      <p>{caption}</p>
      {children && <div className="management-fact-action">{children}</div>}
    </div>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="management-empty"><strong>{title}</strong><span>{detail}</span></div>;
}

function Account({ facts, confirm }: { facts: Facts; confirm: (action: Confirm) => void }) {
  const { state, signedIn } = facts;
  const account = state.snapshot?.account;
  const gateway = state.snapshot?.gateway;
  return (
    <section className="management-account" aria-label="LinkShell 账号">
      <div className="management-account-head">
        <div>
          <h2>LinkShell 账号</h2>
          <p className="management-selectable">{signedIn ? account?.email ?? account?.userId : "登录后，在手机上使用同一账号连接这台 Mac。"}</p>
        </div>
        {state.signingIn ? (
          <div className="desktop-page-actions">
            <LoaderCircle className="animate-spin management-muted" size={16} aria-label="正在登录" />
            <Button variant="outline" onClick={cancelLogin}>取消登录</Button>
          </div>
        ) : signedIn ? (
          <Button variant="outline" disabled={state.busy} onClick={() => confirm("logout")}>退出登录…</Button>
        ) : (
          <Button disabled={state.busy} onClick={() => void login()}>登录 / 注册</Button>
        )}
      </div>
      {state.accountMessage && <p className="management-hint management-selectable">{state.accountMessage}</p>}
      {signedIn ? (
        <>
          <Membership state={state} />
          <div className="management-account-gateway">
            <span>网关：{facts.gateway}</span>
            {gateway?.status !== "online" && (
              <Button size="sm" variant="outline" disabled={state.busy} onClick={() => confirm("connect-gateway")}>连接官方网关…</Button>
            )}
          </div>
          {gateway?.error?.message && <p className="management-note management-selectable" data-tone="warning">{gateway.error.message}</p>}
        </>
      ) : <p className="management-hint">官方网关需要 Pro；自建网关仍可通过配对使用。</p>}
    </section>
  );
}

function Membership({ state }: { state: ManagementState }) {
  const membership = membershipOf(state.snapshot?.account);
  const [code, setCode] = useState("");
  const redeem = async () => { if (await redeemPro(code)) setCode(""); };
  return (
    <div className="management-membership">
      <div className="management-membership-line">
        {membership.kind === "pro" ? (
          <>
            <Status text="Pro 账户" tone="success" />
            <span className="management-muted">有效期至 {membership.expiresAt.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</span>
          </>
        ) : membership.kind === "free" ? (
          <span className="management-muted">普通账户</span>
        ) : (
          <span className="management-muted">{state.checkingMembership ? "正在查询会员状态…" : "会员状态暂不可用"}</span>
        )}
        {state.checkingMembership
          ? <LoaderCircle className="animate-spin management-muted" size={14} aria-hidden />
          : <Button variant="ghost" size="icon-xs" title="刷新会员状态" aria-label="刷新会员状态" disabled={state.busy} onClick={refreshAccount}><RefreshCw /></Button>}
      </div>
      {membership.kind === "free" && (
        <>
          <form className="management-inline-form" onSubmit={(event) => { event.preventDefault(); void redeem(); }}>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="输入激活码"
              aria-label="Pro 激活码"
              autoComplete="off"
              spellCheck={false}
              disabled={state.busy}
            />
            <Button type="submit" disabled={state.busy || !code.trim()}>{state.redeeming ? "正在兑换…" : "兑换 Pro"}</Button>
          </form>
          <p className="management-hint">
            没有激活码？<Button variant="link" size="plain" onClick={() => openDesktopExternal(PRO_CODE_SHOP_URL)}>前往链动小铺</Button>
          </p>
        </>
      )}
      {state.redemptionMessage && (
        <p className="management-note management-selectable" data-tone={state.redemptionIsError ? "warning" : "success"} role="status">{state.redemptionMessage}</p>
      )}
    </div>
  );
}

function Devices({ facts }: { facts: Facts }) {
  const { state, devices } = facts;
  const gateway = state.snapshot?.gateway;
  return (
    <>
      <ManagementPairing devices={devices} disabled={state.busy} />
      <Group title="已配对设备" trailing={devices.length ? `${devices.length} 台` : undefined}>
        <div className="management-rows">
          {!devices.length && <Empty title="暂无已配对设备" detail="在手机中打开「电脑 → 添加电脑」，扫描上方生成的二维码。" />}
          {devices.map((device) => (
            <Row key={device.id} title={device.name}>
              <Status text={device.online ? "在线" : "离线"} tone={device.online ? "success" : undefined} />
            </Row>
          ))}
        </div>
      </Group>
      {gateway?.url && <p className="management-hint management-mono management-selectable">{gateway.url}</p>}
      {gateway?.error?.message && <p className="management-note" data-tone="warning">{gateway.error.message}</p>}
    </>
  );
}

function Password({ facts, confirm }: { facts: Facts; confirm: (action: Confirm) => void }) {
  const { state } = facts;
  const enabled = state.snapshot?.access?.password ?? false;
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const mismatch = !!again && again !== password;
  const valid = password.length >= 4 && password.length <= 128 && password === again;
  const close = () => { setEditing(false); setPassword(""); setAgain(""); };
  const save = async () => { if (valid && await setAccessPassword(password)) close(); };
  return (
    <>
      <Group title="这台电脑的密码">
        <div className="management-panel">
          <div className="management-password-head">
            {enabled ? <Lock size={16} aria-hidden /> : <LockOpen size={16} className="management-muted" aria-hidden />}
            <div>
              <strong>{enabled ? "已开启" : "未设置"}</strong>
              <p>{enabled
                ? "其他设备（手机、其他电脑）打开这台 Mac 前要先输入密码。这台 Mac 自己不用输。"
                : "设置后，同一账号或已配对的其他设备打开这台 Mac 前要先输入密码。随时可以修改或移除。"}</p>
            </div>
            {!editing && (
              <div className="desktop-page-actions">
                <Button variant="outline" disabled={state.busy} onClick={() => { clearPasswordMessage(); setEditing(true); }}>{enabled ? "修改" : "设置密码"}</Button>
                {enabled && <Button variant="ghost" disabled={state.busy} onClick={() => confirm("remove-password")}>移除</Button>}
              </div>
            )}
          </div>
          {editing && (
            <form className="management-password-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <Input type="password" autoFocus autoComplete="new-password" maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)}
                placeholder={enabled ? "新密码（至少 4 位）" : "密码（至少 4 位）"} aria-label="新密码" />
              <Input type="password" autoComplete="new-password" maxLength={128} value={again} onChange={(event) => setAgain(event.target.value)}
                placeholder="再输一次" aria-label="再输一次密码" aria-invalid={mismatch || undefined} />
              {mismatch && <p className="management-note" data-tone="warning">两次输入不一致</p>}
              <div className="desktop-page-actions">
                <Button type="submit" disabled={state.busy || !valid}>{state.savingPassword ? "正在保存…" : "保存"}</Button>
                <Button type="button" variant="ghost" onClick={close}>取消</Button>
              </div>
            </form>
          )}
          {state.passwordMessage && (
            <p className="management-note management-selectable" data-tone={state.passwordIsError ? "warning" : undefined} role="status">{state.passwordMessage}</p>
          )}
        </div>
      </Group>
      <Group title="怎么生效">
        <div className="management-rows">
          <Row title="其他设备"><span className="management-muted">手机、网页和其他电脑上，这台电脑会带一把锁</span></Row>
          <Row title="打开时"><span className="management-muted">先输入密码；输错 5 次要等 5 分钟</span></Row>
          <Row title="记住多久"><span className="management-muted">同一台设备解锁后 7 天内不用再输</span></Row>
          <Row title="修改或移除"><span className="management-muted">已连接的设备会断开，按新设置重新连接</span></Row>
          <Row title="这台 Mac"><span className="management-muted">本机的工作台和命令行不需要密码</span></Row>
        </div>
      </Group>
      <p className="management-hint management-selectable">每台电脑各自设置自己的密码，互不影响；没设密码的电脑照常使用。命令行也可以设置：linkshell password set</p>
    </>
  );
}

/** The log page's toolbar actions: read again, and show the file. */
function LogActions() {
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => void readLog()}><RefreshCw />刷新</Button>
      <Button variant="ghost" size="sm" onClick={() => void desktopInvoke("revealLog")}><FolderOpen />在 Finder 中显示</Button>
    </>
  );
}

function Log({ facts }: { facts: Facts }) {
  return (
    <>
      <pre className="management-log" tabIndex={0}>{facts.state.log || "正在读取…"}</pre>
      <p className="management-hint management-mono management-selectable">{facts.home}/host.log</p>
    </>
  );
}

function Updates({ facts, confirm }: { facts: Facts; confirm: (action: Confirm) => void }) {
  const { state, standalone, newVersion } = facts;
  const update = state.update;
  return (
    <>
      <Group title="版本">
        <div className="management-rows">
          <Row title="安装来源"><span className="management-muted">{sourceLabel(state.snapshot, standalone)}</span></Row>
          <Row title="CLI 版本"><span className="management-mono">{state.snapshot?.cliVersion ?? "未知"}</span></Row>
          <Row title="运行中的 Host"><span className="management-mono">{state.snapshot?.machine?.hostVersion ?? "未连接"}</span></Row>
          <Row title="桌面版本"><span className="management-mono">{state.about?.version ?? "开发版"}</span></Row>
          <Row title="更新通道">
            {standalone ? (
              <Tabs value={state.settings.updateChannel} onValueChange={(value) => void setDesktopSetting("updateChannel", value === "beta" ? "beta" : "stable")}>
                <TabsList variant="line" aria-label="更新通道">
                  <TabsTrigger value="stable" disabled={update.checking}>稳定版</TabsTrigger>
                  <TabsTrigger value="beta" disabled={update.checking}>测试版</TabsTrigger>
                </TabsList>
              </Tabs>
            ) : <span className="management-muted">稳定版 · latest</span>}
          </Row>
          <Row title="自动检查更新">
            <Switch checked={state.settings.autoCheck} onCheckedChange={(value) => void setDesktopSetting("autoCheck", value)} aria-label="自动检查更新" />
          </Row>
          {/* Where things stand and what to do about it, as the version box's last row. */}
          <div className="management-row management-update-row">
            <span className="management-update-message management-selectable" role="status">{update.message || "尚未检查"}</span>
            <div>
              <Button variant={newVersion ? "ghost" : "outline"} size="sm" disabled={update.checking} onClick={() => void checkUpdates()}>
                {update.checking ? "正在检查…" : "检查更新"}
              </Button>
              {newVersion && standalone && <Button size="sm" disabled={state.busy || update.checking || update.installing} onClick={installUpdate}>下载并更新 App…</Button>}
              {newVersion && !standalone && <Button size="sm" disabled={state.busy || update.checking} onClick={() => confirm("upgrade")}>安装更新…</Button>}
            </div>
          </div>
        </div>
      </Group>
      <p className="management-hint">
        {standalone
          ? "App、内置 CLI、Host 与运行时作为整体更新。下载期间服务保持连接；仅在确认安装并重启时短暂重启服务，完成后自动恢复。"
          : "此安装通过 npm 或 Homebrew 更新（linkshell upgrade）。安装时可能重启后台服务，请先完成正在执行的任务。"}
      </p>
    </>
  );
}

function SettingsPage({ facts }: { facts: Facts }) {
  const { state, standalone } = facts;
  const [appearance, setAppearance] = useAppearance();
  const permissions = state.permissions;
  const granted = (value: boolean) => (!permissions.known ? "未知" : value ? "已授权" : "未授权");
  return (
    <>
      <Group title="外观与启动">
        <div className="management-rows">
          <Row title="外观">
            <Tabs value={appearance} onValueChange={(value) => setAppearance(value as Appearance)}>
              <TabsList variant="line" aria-label="外观">
                <TabsTrigger value="system">跟随系统</TabsTrigger>
                <TabsTrigger value="light">浅色</TabsTrigger>
                <TabsTrigger value="dark">深色</TabsTrigger>
              </TabsList>
            </Tabs>
          </Row>
          <Row title="窗口不透明">
            <Switch checked={state.settings.opaqueWindow} onCheckedChange={(value) => void setDesktopSetting("opaqueWindow", value)} aria-label="窗口不透明" />
          </Row>
          {standalone && (
            <Row title="登录 Mac 时自动启动">
              <Switch checked={state.loginItem.enabled} onCheckedChange={(value) => void setLaunchAtLogin(value)} aria-label="登录 Mac 时自动启动" />
            </Row>
          )}
        </div>
        {standalone && <p className="management-hint">登录 Mac 后自动打开 LinkShell。每次打开桌面版都会启动后台服务并连接已配置的网关，无需再点“启动服务”。</p>}
        {state.loginItem.approval && (
          <div className="management-banner" data-tone="warning">
            <span>等待系统允许，请在“登录项”中启用 LinkShell。</span>
            <Button variant="outline" size="sm" onClick={openLoginItems}>打开系统登录项设置</Button>
          </div>
        )}
        {state.loginItemMessage && <p className="management-note management-selectable" data-tone="warning">{state.loginItemMessage}</p>}
      </Group>
      <Group title="让手机查看和控制这台 Mac">
        <div className="management-rows">
          <Row title="屏幕录制"><Status text={granted(permissions.recording)} tone={permissions.known && permissions.recording ? "success" : undefined} /></Row>
          <Row title="辅助功能"><Status text={granted(permissions.control)} tone={permissions.known && permissions.control ? "success" : undefined} /></Row>
          <Row title="需要修改系统授权时，可打开权限向导或系统设置。">
            <Button variant="outline" size="sm" onClick={openSetup}>打开权限设置</Button>
          </Row>
        </div>
      </Group>
      <Group title="数据">
        <div className="management-rows">
          <Row title="数据目录"><span className="management-mono management-selectable">{facts.home}</span></Row>
        </div>
        <p className="management-hint">窗口关闭后，LinkShell 留在菜单栏。退出界面不会停止 Host 或代理任务。</p>
      </Group>
      {standalone && (
        <Group title="命令行工具">
          <p className="management-hint">使用 App 内置 CLI，与 App 一起升级。已有 npm / Homebrew 安装不会被改动。</p>
          <div className="desktop-page-actions management-update-actions">
            <Button variant="outline" onClick={() => void installCommand()}>安装到 ~/.local/bin</Button>
            <Button variant="ghost" disabled={state.busy} onClick={() => void serviceAction("recover-update")}>重试恢复后台服务</Button>
          </div>
          {state.commandMessage && <p className="management-note management-selectable">{state.commandMessage}</p>}
        </Group>
      )}
    </>
  );
}

/**
 * Management's pages, in the window's sidebar while management is open (as Codex's settings
 * take the sidebar), so the content has the whole main panel.
 */
export function ManagementNav({ page, navigate, back }: { page: ManagePage; navigate: (page: ManagePage) => void; back: () => void }) {
  const facts = useFacts();
  const machine = facts.state.snapshot?.machine?.hostname.replace(/\.local$/, "");
  return (
    <nav className="management-nav" aria-label="本机管理">
      <button type="button" className="desktop-place management-back" onClick={back}>
        <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
        <span>返回工作台</span>
        <kbd>⌘1</kbd>
      </button>
      <div className="management-machine">
        <span className="desktop-presence" data-online={facts.healthy || undefined} aria-hidden />
        <div>
          <strong>{machine ?? "这台 Mac"}</strong>
          <span>本机服务{facts.service}</span>
        </div>
      </div>
      {MANAGE_PAGES.map((id, index) => {
        const Icon = pageIcons[id];
        return (
          <button
            type="button"
            key={id}
            className="management-nav-item"
            data-active={page === id || undefined}
            data-gap={index === 5 || undefined}
            aria-current={page === id ? "page" : undefined}
            onClick={() => navigate(id)}
          >
            <Icon size={16} strokeWidth={1.6} aria-hidden />
            <span>{managePageTitles[id]}</span>
            {id === "updates" && facts.newVersion && <span className="management-dot" aria-label="有新版本" />}
          </button>
        );
      })}
      <p className="management-nav-foot">
        服务{facts.service} · 网关{facts.gateway}
        {facts.state.snapshot?.machine?.hostVersion && <span className="management-mono">Host {facts.state.snapshot.machine.hostVersion}</span>}
      </p>
    </nav>
  );
}
