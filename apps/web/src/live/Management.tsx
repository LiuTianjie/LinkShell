import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PageHeader } from "../components/PageHeader";
import { useStore } from "zustand";
import {
  ArrowDown,
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  CircleArrowDown,
  Ellipsis,
  FileText,
  FolderOpen,
  Gauge,
  House,
  LoaderCircle,
  Lock,
  RefreshCw,
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
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { officialGateway } from "../config";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { desktopInvoke, isWindowsDesktop, openDesktopExternal, reportDesktopError, revealOnDesktop, THIS_COMPUTER_SPACED, THIS_COMPUTER, REVEAL_IN_FILES } from "./desktop";
import { desktopModeShortcuts, shortcutText } from "./desktop-commands";
import { useDesktopAppearance, type Appearance } from "./desktop-appearance";
import {
  accountAction,
  cancelLogin,
  checkUpdates,
  clearGatewayMessage,
  clearPasswordMessage,
  clearSignInError,
  healthy as isHealthy,
  copyCommandPath,
  installCommand,
  installUpdate,
  login,
  loginWithPassword,
  loginWithProvider,
  setGateway,
  type GatewayChoice,
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
  setScreenSharing,
  standalone as isStandalone,
  type ManagementState,
} from "./management-store";
import {
  MANAGE_PAGES,
  gatewayLabel,
  managePageTitles,
  membershipOf,
  parseHostLog,
  serviceLabel,
  sourceLabel,
  splitPath,
  type ManagePage,
} from "./management-model";
import { ManagementPairing } from "./ManagementPairing";
import { ManagementUsage } from "./ManagementUsage";
import { SignIn } from "./SignIn";
import "../styles/management.css";

type Confirm = "stop" | "restart" | "logout" | "remove-password" | "upgrade";

// Closed outline shapes of one weight, so the column of icons reads as one set.
const pageIcons: Record<ManagePage, LucideIcon> = {
  overview: House, devices: Smartphone, password: Lock, usage: Gauge, log: FileText, updates: CircleArrowDown, settings: Settings,
};
const confirmCopy: Record<Confirm, { title: string; detail: string; action: string }> = {
  stop: { title: "停止本机服务？", detail: "正在执行的代理任务、终端与远程连接可能中断。会话记录和配对信息会保留。", action: "停止" },
  restart: { title: "重启本机服务？", detail: "正在执行的代理任务、终端与远程连接可能中断。会话记录和配对信息会保留。", action: "重启" },
  logout: { title: "退出当前账号？", detail: `${THIS_COMPUTER_SPACED}将退出账号，账号关联的远程连接可能断开。本机会话和配对记录会保留。`, action: "退出登录" },
  "remove-password": { title: "移除访问密码？", detail: `其他设备将可以直接打开${THIS_COMPUTER}，不再需要输入密码。`, action: "移除" },
  upgrade: { title: "安装更新？", detail: "将运行 linkshell upgrade 更新 CLI 和 Host。正在执行的代理任务、终端与远程连接可能中断。", action: "安装" },
};
const LOG_REFRESH_MS = 5_000;
/** Within this of the end, the log counts as read to the end and follows new lines. */
const LOG_END_SLACK = 24;

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
    home: state.about?.home ?? state.snapshot?.home ?? "~/.linkshell",
  };
}
type Facts = ReturnType<typeof useFacts>;


/** 本机管理: LinkShell.app's native dashboard, now a page of the Electron window. */
export function Management({ page, navigate }: { page: ManagePage; navigate: (page: ManagePage) => void }) {
  const facts = useFacts();
  const { state } = facts;
  const [confirm, setConfirm] = useState<Confirm>();
  useEffect(pollManagement, []);
  useEffect(() => {
    if (page !== "log") return;
    void readLog();
    const timer = setInterval(() => void readLog(), LOG_REFRESH_MS);
    return () => clearInterval(timer);
  }, [page]);

  const run = (action: Confirm) => {
    if (action === "remove-password") void setAccessPassword(null);
    else if (action === "logout") void accountAction(action);
    else if (action === "upgrade") void upgradeInstall();
    else void serviceAction(action);
  };
  const hostVersion = state.snapshot?.machine?.hostVersion;

  return (
    <div className="management">
      <div className="management-content">
        <div className="management-page">
          {page !== "usage" && (
            <PageHeader
              // The sidebar names the Mac and the rows say how it is: the toolbar names the page
              // and at most one fact.
              title={managePageTitles[page]}
              detail={page === "overview" ? (hostVersion ? `Host ${hostVersion}` : undefined)
                : page === "log" ? <span className="management-log-detail"><span>每 5 秒刷新</span><Path text={`${facts.home}/host.log`} /></span>
                : undefined}
              actions={<>
                {state.busy && <LoaderCircle className="animate-spin management-muted" size={16} aria-label="正在处理" />}
                {page === "log" && (
                  <Button variant="ghost" size="sm" onClick={() => void desktopInvoke("revealLog")}><FolderOpen />{REVEAL_IN_FILES}</Button>
                )}
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" disabled={state.busy} aria-label="本机服务操作"><Ellipsis /></Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>本机服务</TooltipContent>
                  </Tooltip>
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
                <Button variant="secondary" size="sm" onClick={refreshManagement}>重试</Button>
              </AlertDescription>
            </Alert>
          )}
          {page === "overview" && <Overview facts={facts} confirm={setConfirm} navigate={navigate} />}
          {page === "devices" && <Devices facts={facts} />}
          {page === "password" && <Password facts={facts} confirm={setConfirm} />}
          {page === "usage" && <ManagementUsage />}
          {page === "log" && <Log text={state.log} />}
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

/**
 * A group, as Codex's settings sections: a title flush with its box, the rows in one rounded box,
 * then any footnotes, which belong to the group and sit under the rows' text.
 */
function Group({ title, trailing, children }: { title: string; trailing?: string; children: ReactNode }) {
  return (
    <section className="management-group" aria-label={title}>
      <h2 className="management-group-title">{title}{trailing && <span>{trailing}</span>}</h2>
      {children}
    </section>
  );
}

function Note({ children, tone, role }: { children: ReactNode; tone?: "warning" | "success"; role?: "status" | "alert" }) {
  return <p className="management-footnote management-selectable" data-tone={tone} role={role}>{children}</p>;
}

/** A state as a dot and, unless the row's own words already say it, a word. */
function Status({ text, tone, label }: { text?: string; tone?: "success" | "warning"; label?: string }) {
  return (
    <span className="management-status" data-tone={tone} title={text ? undefined : label} aria-label={text ? undefined : label} role={text ? undefined : "img"}>
      <span aria-hidden />{text}
    </span>
  );
}

/**
 * One setting, as Codex's settings rows: what it is and a line of why on the left; its state or
 * control on the right. With `onClick` the whole row is the way there.
 */
function SettingRow({ title, detail, children, onClick }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <div className="management-setting-copy">
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </div>
      {children && <div className="management-setting-control">{children}</div>}
    </>
  );
  return onClick
    ? <button type="button" className="management-row" data-link="" onClick={onClick}>{body}</button>
    : <div className="management-row">{body}</div>;
}

/** A path that keeps its last component when it has to be cut: the cut is in the middle. */
function Path({ text }: { text: string }) {
  const [head, tail] = splitPath(text);
  return <span className="management-path management-selectable" title={text}><span>{head}</span><span>{tail}</span></span>;
}

/** One of the two macOS permissions the screen needs: its state, and the way to grant it. */
function Permission({ known, granted }: { known: boolean; granted: boolean }) {
  if (!known) return <Status text="未知" />;
  if (granted) return <Status text="已授权" tone="success" />;
  return (
    <>
      <Status text="未授权" tone="warning" />
      <Button size="sm" variant="secondary" onClick={openSetup}>授权…</Button>
    </>
  );
}

function missingPermissions(permissions: ManagementState["permissions"]): string {
  if (!permissions.recording && !permissions.control) return "缺少屏幕录制与辅助功能权限";
  return permissions.recording ? "缺少辅助功能权限：手机能看屏幕，还不能操作" : "缺少屏幕录制权限：手机还看不到屏幕";
}

function Overview({ facts, confirm, navigate }: { facts: Facts; confirm: (action: Confirm) => void; navigate: (page: ManagePage) => void }) {
  const { state, healthy, devices, signedIn } = facts;
  const gateway = state.snapshot?.gateway;
  const permissions = state.permissions;
  const screenReady = permissions.recording && permissions.control;
  const external = facts.standalone && healthy && !!state.about?.bundle && state.snapshot?.hostOwner !== state.about.bundle;
  const online = devices.filter((device) => device.online).length;
  const gatewayDetail = gateway?.error?.message
    ?? (!healthy ? "本机服务运行后可用"
      : gateway?.status === "online" ? "不在同一网络也能连上"
      : gateway?.status === "connecting" ? "正在连接网关…"
      : signedIn ? "只能在同一网络内连接；可接入官方网关（需要 Pro）" : "只能在同一网络内连接；登录后可接入官方网关");
  const activity = state.activity.slice(0, 5);
  const [choosingGateway, setChoosingGateway] = useState(false);
  return (
    <>
      <GatewayDialog open={choosingGateway} close={() => setChoosingGateway(false)} signedIn={signedIn} />
      <Account facts={facts} confirm={confirm} />
      {external && (
        <div className="management-banner" data-tone="warning">
          <span>当前服务由另一套 CLI 启动</span>
          <Button variant="secondary" size="sm" disabled={state.busy} onClick={() => confirm("restart")}>切换到 App 内置服务…</Button>
        </div>
      )}
      <Group title={THIS_COMPUTER}>
        <div className="management-rows">
          <SettingRow title="本机服务" detail={healthy ? "手机和工作台随时可以连接" : `启动后，即可从手机连接${THIS_COMPUTER}`}>
            <Status text={facts.service} tone={healthy ? "success" : "warning"} />
            {!healthy && state.snapshot?.status === "stopped" && <Button size="sm" variant="secondary" disabled={state.busy} onClick={() => void serviceAction("start")}>启动服务</Button>}
          </SettingRow>
          <SettingRow title="网关" detail={gatewayDetail}>
            <Status
              text={facts.gateway}
              tone={!healthy ? undefined : gateway?.status === "online" ? "success" : gateway?.status === "offline" || gateway?.error ? "warning" : undefined}
            />
            {healthy && <Button size="sm" variant="secondary" disabled={state.busy} onClick={() => setChoosingGateway(true)}>更改…</Button>}
          </SettingRow>
          <SettingRow
            title="屏幕与控制"
            detail={!permissions.known ? "需要屏幕录制与辅助功能两项权限" : screenReady ? "可以从手机查看和操作屏幕"
              : permissions.sharing === false ? "已在设置中关闭远程屏幕" : missingPermissions(permissions)}
          >
            {!permissions.known ? <Status text="检查中" />
              : screenReady ? <Status text="已就绪" tone="success" />
              : permissions.sharing === false ? <><Status tone="warning" label="已关闭" /><Button size="sm" variant="secondary" onClick={() => navigate("settings")}>设置…</Button></>
              : <><Status tone="warning" label="未授权" /><Button size="sm" variant="secondary" onClick={openSetup}>授权…</Button></>}
          </SettingRow>
          <SettingRow
            title="已配对设备"
            detail={!devices.length ? "扫码配对手机，或用同一账号登录" : online ? `${online} 台在线` : "都不在线"}
            onClick={() => navigate("devices")}
          >
            <span className="management-value">{devices.length} 台</span>
            <ChevronRight className="management-chevron" size={16} aria-hidden />
          </SettingRow>
        </div>
      </Group>
      {/* A single line is only the startup itself: the group earns its place from the second. */}
      {activity.length >= 2 && (
        <Group title="最近活动">
          <div className="management-rows">
            {activity.map((event) => (
              <div className="management-activity" key={`${event.at}:${event.text}`}>
                <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
                <span>{event.text}</span>
              </div>
            ))}
            <button type="button" className="management-activity" data-link="" onClick={() => navigate("log")}>
              <span>查看日志</span>
              <ChevronRight className="management-chevron" size={16} aria-hidden />
            </button>
          </div>
        </Group>
      )}
    </>
  );
}

function Account({ facts, confirm }: { facts: Facts; confirm: (action: Confirm) => void }) {
  const { state, signedIn } = facts;
  const account = state.snapshot?.account;
  const [signingIn, setSigningIn] = useState(false);
  // Signed in some other way meanwhile (the CLI, the workspace): a later sign-out must not reopen it.
  if (signedIn && signingIn) setSigningIn(false);
  return (
    <Group title="LinkShell 账号">
      <div className="management-rows">
        <SettingRow
          title={signedIn ? <span className="management-selectable">{account?.email ?? account?.userId}</span> : "未登录"}
          detail={signedIn ? `手机登录同一账号，即可连接${THIS_COMPUTER}` : `登录后，在手机上用同一账号连接${THIS_COMPUTER}。官方网关需要 Pro；自建网关仍可配对使用。`}
        >
          {state.signingIn ? (
            <>
              <LoaderCircle className="animate-spin management-muted" size={16} aria-label="正在登录" />
              <Button variant="secondary" size="sm" onClick={cancelLogin}>取消登录</Button>
            </>
          ) : signedIn ? (
            <Button variant="ghost" size="sm" disabled={state.busy} onClick={() => confirm("logout")}>退出登录…</Button>
          ) : (
            <Button size="sm" disabled={state.busy} onClick={() => setSigningIn(true)}>登录…</Button>
          )}
        </SettingRow>
        {signedIn && <Membership state={state} />}
      </div>
      {state.accountMessage && <Note>{state.accountMessage}</Note>}
      {signedIn && state.redemptionMessage && (
        <Note tone={state.redemptionIsError ? "warning" : "success"} role="status">{state.redemptionMessage}</Note>
      )}
      <SignInDialog open={signingIn && !signedIn} close={() => setSigningIn(false)} />
    </Group>
  );
}

const sameGateway = (a: string, b: string) => {
  const key = (url: string) => url.trim().replace(/^http/i, "ws").replace(/\/+$/, "").toLowerCase();
  return key(a) === key(b);
};

/**
 * Where phones reach this Mac from outside its network: the official gateway (an account finds
 * it, Pro), one's own (`linkshell gateway` or the Docker image; phones pair by code), or none.
 */
function GatewayDialog({ open, close, signedIn }: { open: boolean; close: () => void; signedIn: boolean }) {
  const state = useStore(management);
  const gateway = state.snapshot?.gateway;
  const current: GatewayChoice["kind"] = gateway?.status === "off" || !gateway?.url ? "off" : sameGateway(gateway.url, officialGateway) ? "official" : "own";
  const [kind, setKind] = useState<GatewayChoice["kind"]>(current);
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!open) return;
    setKind(current);
    setUrl(current === "own" ? gateway?.url ?? "" : "");
    clearGatewayMessage();
    // Read again each time it opens; what it shows while open is the person's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = async () => {
    if (await setGateway(kind === "own" ? { kind, url: url.trim() } : { kind })) close();
  };
  const options: { value: GatewayChoice["kind"]; title: string; detail: string; disabled?: boolean }[] = [
    { value: "official", title: "官方网关", detail: signedIn ? `手机登录同一账号即可发现${THIS_COMPUTER}，需要 Pro` : "登录账号后可用", disabled: !signedIn },
    { value: "own", title: "自建网关", detail: "用 linkshell gateway 或 Docker 镜像部署，手机扫码或输入配对码连接" },
    { value: "off", title: "关闭", detail: "只在同一网络内连接" },
  ];
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !state.busy) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>网关</DialogTitle>
          <DialogDescription>手机不在同一网络时，通过网关连接{THIS_COMPUTER}。内容端到端加密，网关只转发。切换后现有的远程连接会断开重连。</DialogDescription>
        </DialogHeader>
        <form className="gateway-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <RadioGroup value={kind} onValueChange={(value) => { setKind(value as GatewayChoice["kind"]); clearGatewayMessage(); }} aria-label="网关">
            {options.map((option) => (
              <label key={option.value} className="gateway-option" data-disabled={option.disabled || undefined}>
                <RadioGroupItem value={option.value} disabled={option.disabled} />
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.detail}</small>
                </span>
              </label>
            ))}
          </RadioGroup>
          {kind === "own" && (
            <Input
              autoFocus
              aria-label="自建网关地址"
              placeholder="wss://gateway.example.com"
              autoComplete="off"
              spellCheck={false}
              maxLength={2048}
              value={url}
              aria-invalid={!!state.gatewayMessage}
              onChange={(event) => { setUrl(event.target.value); clearGatewayMessage(); }}
            />
          )}
          {state.gatewayMessage && <p className="gateway-error" role="alert">{state.gatewayMessage}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={state.busy}>取消</Button>
            </DialogClose>
            <Button type="submit" disabled={state.busy || (kind === "own" && !url.trim())}>
              {state.busy && <LoaderCircle className="animate-spin" data-icon="inline-start" />}
              {state.busy ? "正在连接…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The account sign-in, over the management page; it closes itself once this Mac is signed in. */
function SignInDialog({ open, close }: { open: boolean; close: () => void }) {
  const state = useStore(management);
  const waiting = state.signingIn && state.signInMethod !== "password";
  const finished = () => { if (management.getState().snapshot?.account?.state === "signed-in") close(); };
  const dismiss = () => {
    // The browser would come back to a listener that is gone: closing ends the sign-in.
    if (state.signingIn) cancelLogin();
    clearSignInError();
    close();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent
        // A stray click beside the panel must not end a sign-in the browser is still on.
        onInteractOutside={(event) => { if (waiting) event.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>登录 iTool 账号</DialogTitle>
          <DialogDescription>手机登录同一账号，即可通过官方网关连接{THIS_COMPUTER}（需要 Pro）。</DialogDescription>
        </DialogHeader>
        <SignIn
          pending={state.signingIn ? state.signInMethod : undefined}
          link={state.signInLink}
          error={state.signInError}
          disabled={state.busy && !state.signingIn}
          onPassword={(email, password) => void loginWithPassword(email, password).then(finished)}
          onProvider={(provider) => void loginWithProvider(provider).then(finished)}
          onBrowser={() => void login().then(finished)}
          onCancel={cancelLogin}
          onEdit={clearSignInError}
        />
      </DialogContent>
    </Dialog>
  );
}

function Membership({ state }: { state: ManagementState }) {
  const membership = membershipOf(state.snapshot?.account);
  const [code, setCode] = useState("");
  const redeem = async () => { if (await redeemPro(code)) setCode(""); };
  return (
    <>
      <SettingRow
        title="会员"
        detail={membership.kind === "pro"
          ? `有效期至 ${membership.expiresAt.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}`
          : membership.kind === "free" ? "兑换 Pro 后，可通过官方网关在任何网络连接" : state.checkingMembership ? "正在查询会员状态…" : "会员状态暂不可用"}
      >
        {membership.kind === "pro" ? <Status text="Pro" tone="success" /> : membership.kind === "free" ? <span className="management-value">普通账户</span> : null}
        {state.checkingMembership
          ? <LoaderCircle className="animate-spin management-muted" size={16} aria-hidden />
          : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="刷新会员状态" disabled={state.busy} onClick={refreshAccount}><RefreshCw /></Button>
              </TooltipTrigger>
              <TooltipContent>刷新会员状态</TooltipContent>
            </Tooltip>
          )}
      </SettingRow>
      {membership.kind === "free" && (
        <SettingRow
          title="兑换 Pro"
          detail={<>没有激活码？<Button variant="link" size="plain" onClick={() => openDesktopExternal(PRO_CODE_SHOP_URL)}>前往链动小铺</Button></>}
        >
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
            <Button type="submit" size="sm" variant="secondary" disabled={state.busy || !code.trim()}>{state.redeeming ? "正在兑换…" : "兑换"}</Button>
          </form>
        </SettingRow>
      )}
    </>
  );
}

function Devices({ facts }: { facts: Facts }) {
  const { state, devices } = facts;
  const gateway = state.snapshot?.gateway;
  return (
    <>
      <Group title="添加设备">
        <ManagementPairing devices={devices} disabled={state.busy} />
        <Note>用同一账号登录的手机会自动发现{THIS_COMPUTER}，配对不需要账号。不登录配对需要自建网关；官方网关需要 Pro。</Note>
      </Group>
      <Group title="已配对设备" trailing={devices.length ? `${devices.length} 台` : undefined}>
        <div className="management-rows">
          {!devices.length && <div className="management-row management-empty-row">还没有配对的设备</div>}
          {devices.map((device) => (
            <SettingRow key={device.id} title={device.name}>
              <Status text={device.online ? "在线" : "离线"} tone={device.online ? "success" : undefined} />
            </SettingRow>
          ))}
        </div>
        {gateway?.url && <Note>配对网关：{gateway.url}</Note>}
        {gateway?.error?.message && <Note tone="warning">{gateway.error.message}</Note>}
      </Group>
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
  const edit = () => { clearPasswordMessage(); setEditing(true); };
  return (
    <Group title={THIS_COMPUTER}>
      <div className="management-rows">
        <SettingRow
          title="访问密码"
          detail={enabled
            ? `手机、网页和其他电脑打开${THIS_COMPUTER_SPACED}前要先输入密码，输错 5 次要等 5 分钟；同一设备 7 天内不用再输。`
            : `设置后，手机、网页和其他电脑打开${THIS_COMPUTER_SPACED}前要先输入密码；同一设备解锁后 7 天内不用再输。`}
        >
          {enabled && <Status text="已开启" tone="success" />}
          {!editing && (enabled ? (
            <>
              <Button size="sm" variant="secondary" disabled={state.busy} onClick={edit}>修改</Button>
              <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => confirm("remove-password")}>移除…</Button>
            </>
          ) : <Button size="sm" disabled={state.busy} onClick={edit}>设置密码</Button>)}
        </SettingRow>
        {editing && (
          <form className="management-row management-password-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <Input type="password" autoFocus autoComplete="new-password" maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)}
              placeholder={enabled ? "新密码（至少 4 位）" : "密码（至少 4 位）"} aria-label="新密码" />
            <Input type="password" autoComplete="new-password" maxLength={128} value={again} onChange={(event) => setAgain(event.target.value)}
              placeholder="再输一次" aria-label="再输一次密码" aria-invalid={mismatch || undefined} />
            {mismatch && <p className="management-field-note" data-tone="warning">两次输入不一致</p>}
            <div className="management-form-actions">
              <Button type="submit" size="sm" disabled={state.busy || !valid}>{state.savingPassword ? "正在保存…" : "保存"}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={close}>取消</Button>
            </div>
          </form>
        )}
      </div>
      {state.passwordMessage && <Note tone={state.passwordIsError ? "warning" : undefined} role="status">{state.passwordMessage}</Note>}
      <Note>{THIS_COMPUTER_SPACED}上的工作台和命令行不用输密码。修改或移除会断开已连接的设备，它们会按新设置重新连接。终端里也可以运行 <code>linkshell password set</code>。</Note>
    </Group>
  );
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");
const logTime = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
function logDay(date: Date) {
  return date.toDateString() === new Date().toDateString() ? "今天" : `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * The Host's log, newest at the bottom and followed there, as a terminal would: lines wrap with
 * the text hanging under its first line, times are local, and a day starts with its date.
 * Scrolled up, it stays put while lines arrive and offers the way back to the end.
 */
function Log({ text }: { text: string }) {
  const entries = useMemo(() => parseHostLog(text), [text]);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const toEnd = () => { const element = scroller.current; if (element) element.scrollTop = element.scrollHeight; };
  useLayoutEffect(() => { if (following.current) toEnd(); }, [entries]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // A resized window rewraps the lines: the end has to be found again.
    const observer = new ResizeObserver(() => { if (following.current) toEnd(); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scrolled = () => {
    const element = scroller.current;
    if (!element) return;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= LOG_END_SLACK;
    following.current = atEnd;
    setAway(!atEnd);
  };
  const jump = () => {
    following.current = true;
    setAway(false);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  let day = "";
  return (
    <div className="management-log">
      <div ref={scroller} className="management-log-scroll" tabIndex={0} role="log" aria-label="Host 日志" onScroll={scrolled}>
        {!text && <p className="management-log-empty">正在读取…</p>}
        {entries.map((entry, index) => {
          const date = entry.at === undefined ? undefined : new Date(entry.at);
          const label = date ? logDay(date) : "";
          const divider = label && label !== day ? label : "";
          if (label) day = label;
          return (
            <div key={`${entry.at ?? ""}:${index}`} className="management-log-entry">
              {divider && <div className="management-log-day">{divider}</div>}
              <div className="management-log-line">
                {date && <time dateTime={date.toISOString()}>{logTime(date)}</time>}
                {entry.tag && <span className="management-log-tag">[{entry.tag}]</span>}
                <span className="management-log-text">{entry.text}</span>
              </div>
            </div>
          );
        })}
      </div>
      {away && (
        <button type="button" className="management-log-jump" onClick={jump}><ArrowDown size={14} aria-hidden />跳到最新</button>
      )}
    </div>
  );
}

function Updates({ facts, confirm }: { facts: Facts; confirm: (action: Confirm) => void }) {
  const { state, standalone, newVersion } = facts;
  const update = state.update;
  const cli = state.snapshot?.cliVersion;
  const host = state.snapshot?.machine?.hostVersion;
  const desktop = state.about?.version;
  // One number while the three parts agree; a row each once they don't.
  const same = !!cli && cli === host && cli === desktop;
  const checked = update.checkedAt ? ` · 上次检查 ${new Date(update.checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "";
  return (
    <Group title="版本">
      <div className="management-rows">
        <SettingRow title="安装来源"><span className="management-value">{sourceLabel(state.snapshot, standalone)}</span></SettingRow>
        {same ? (
          <SettingRow title="版本"><span className="management-value">{cli}</span></SettingRow>
        ) : (
          <>
            <SettingRow title="CLI 版本"><span className="management-value">{cli ?? "未知"}</span></SettingRow>
            <SettingRow title="运行中的 Host"><span className="management-value">{host ?? "未连接"}</span></SettingRow>
            <SettingRow title="桌面版本"><span className="management-value">{desktop ?? "开发版"}</span></SettingRow>
          </>
        )}
        <SettingRow title="更新通道">
          {standalone ? (
            <Tabs value={state.settings.updateChannel} onValueChange={(value) => void setDesktopSetting("updateChannel", value === "beta" ? "beta" : "stable")}>
              <TabsList variant="line" aria-label="更新通道">
                <TabsTrigger value="stable" disabled={update.checking}>稳定版</TabsTrigger>
                <TabsTrigger value="beta" disabled={update.checking}>测试版</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : <span className="management-value">稳定版</span>}
        </SettingRow>
        <SettingRow title="自动检查更新">
          <Switch checked={state.settings.autoCheck} onCheckedChange={(value) => void setDesktopSetting("autoCheck", value)} aria-label="自动检查更新" />
        </SettingRow>
        <SettingRow title="检查更新" detail={<span className="management-selectable" role="status">{(update.message || "尚未检查") + checked}</span>}>
          {newVersion && standalone && <Button size="sm" variant="secondary" disabled={state.busy || update.checking || update.installing} onClick={installUpdate}>下载并更新 App…</Button>}
          {newVersion && !standalone && <Button size="sm" variant="secondary" disabled={state.busy || update.checking} onClick={() => confirm("upgrade")}>安装更新…</Button>}
          <Button variant={newVersion ? "ghost" : "secondary"} size="sm" disabled={update.checking} onClick={() => void checkUpdates()}>
            {update.checking ? "正在检查…" : "立即检查"}
          </Button>
        </SettingRow>
      </div>
      <Note>
        {standalone
          ? "App、内置 CLI、Host 与运行时作为整体更新。下载期间服务保持连接；仅在确认安装并重启时短暂重启服务，完成后自动恢复。"
          : "此安装通过 npm 或 Homebrew 更新（linkshell upgrade）。安装时可能重启后台服务，请先完成正在执行的任务。"}
      </Note>
    </Group>
  );
}

function SettingsPage({ facts }: { facts: Facts }) {
  const { state, standalone } = facts;
  const [appearance, setAppearance] = useDesktopAppearance();
  const permissions = state.permissions;
  // `reveal` takes an absolute path that exists; the fallback `~/.linkshell` is neither.
  const revealable = /^(?:\/|[A-Za-z]:[\\/])/.test(facts.home);
  return (
    <>
      <Group title={standalone ? "外观与启动" : "外观"}>
        <div className="management-rows">
          <SettingRow title="外观">
            <Tabs value={appearance} onValueChange={(value) => setAppearance(value as Appearance)}>
              <TabsList variant="line" aria-label="外观">
                <TabsTrigger value="system">跟随系统</TabsTrigger>
                <TabsTrigger value="light">浅色</TabsTrigger>
                <TabsTrigger value="dark">深色</TabsTrigger>
              </TabsList>
            </Tabs>
          </SettingRow>
          {/* Windows' window is opaque already. */}
          {!isWindowsDesktop && (
            <SettingRow title="窗口不透明" detail="侧栏不再透出桌面">
              <Switch checked={state.settings.opaqueWindow} onCheckedChange={(value) => void setDesktopSetting("opaqueWindow", value)} aria-label="窗口不透明" />
            </SettingRow>
          )}
          {standalone && (
            <SettingRow title="登录时启动" detail={`登录 ${isWindowsDesktop ? "Windows" : "Mac"} 后打开 LinkShell，并启动后台服务、连接已配置的网关`}>
              <Switch checked={state.loginItem.enabled} onCheckedChange={(value) => void setLaunchAtLogin(value)} aria-label="登录时启动" />
            </SettingRow>
          )}
          {state.loginItem.approval && (
            <SettingRow title="等待系统允许" detail="请在系统设置的“登录项”中启用 LinkShell">
              <Status tone="warning" label="等待允许" />
              <Button variant="secondary" size="sm" onClick={openLoginItems}>打开登录项设置</Button>
            </SettingRow>
          )}
        </div>
        {state.loginItemMessage && <Note tone="warning">{state.loginItemMessage}</Note>}
        <Note>窗口关闭后，LinkShell 留在{isWindowsDesktop ? "任务栏的通知区域" : "菜单栏"}。退出界面不会停止 Host 或代理任务。</Note>
      </Group>
      <Group title={`让手机查看和控制${THIS_COMPUTER}`}>
        {isWindowsDesktop ? (
          <>
            <div className="management-rows">
              <SettingRow title="允许远程屏幕与控制" detail="已连接的设备可以查看屏幕、操作鼠标和键盘">
                <Switch checked={permissions.sharing !== false} onCheckedChange={(value) => void setScreenSharing(value)} aria-label="允许远程屏幕与控制" />
              </SettingRow>
            </div>
            <Note>锁屏、UAC 安全桌面和管理员窗口不能控制。关闭后会结束屏幕连接，服务与 Agent 会话继续运行。</Note>
          </>
        ) : (
          <div className="management-rows">
            <SettingRow title="屏幕录制" detail={`手机查看${THIS_COMPUTER_SPACED}的屏幕`}>
              <Permission known={permissions.known} granted={permissions.recording} />
            </SettingRow>
            <SettingRow title="辅助功能" detail={`手机操作${THIS_COMPUTER_SPACED}的鼠标和键盘`}>
              <Permission known={permissions.known} granted={permissions.control} />
            </SettingRow>
          </div>
        )}
      </Group>
      <Group title="数据">
        <div className="management-rows">
          <SettingRow title="数据目录" detail={<Path text={facts.home} />}>
            <Button variant="secondary" size="sm" disabled={!revealable} onClick={() => void revealOnDesktop(facts.home).catch(reportDesktopError)}>显示</Button>
          </SettingRow>
        </div>
      </Group>
      {standalone && (
        <Group title="命令行工具">
          <div className="management-rows">
            {isWindowsDesktop ? (
              <SettingRow title="linkshell 命令" detail="安装目录中的 linkshell.cmd 随桌面版一起更新；已有的 npm 安装和系统 PATH 不受影响">
                <Button variant="secondary" size="sm" onClick={() => void copyCommandPath()}>复制路径</Button>
              </SettingRow>
            ) : (
              <SettingRow title="linkshell 命令" detail="使用 App 内置的 CLI，随 App 一起升级；已有的 npm / Homebrew 安装不受影响">
                <Button variant="secondary" size="sm" onClick={() => void installCommand()}>安装到 ~/.local/bin</Button>
              </SettingRow>
            )}
            <SettingRow title="后台服务" detail="更新被打断后，重新启动内置服务">
              <Button variant="secondary" size="sm" disabled={state.busy} onClick={() => void serviceAction("recover-update")}>重试恢复</Button>
            </SettingRow>
          </div>
          {state.commandMessage && <Note>{state.commandMessage}</Note>}
        </Group>
      )}
    </>
  );
}

/**
 * Management's pages, in the window's sidebar while management is open (as Codex's settings
 * take the sidebar), so the content has the whole main panel. They are the workspace sidebar's
 * own rows, so icons and words sit in the same columns on either side of the switch.
 */
export function ManagementNav({ page, navigate, back }: { page: ManagePage; navigate: (page: ManagePage) => void; back: () => void }) {
  const facts = useFacts();
  const machine = facts.state.snapshot?.machine?.hostname.replace(/\.local$/, "");
  return (
    <nav className="management-nav" aria-label="本机管理">
      <button type="button" className="desktop-place management-back" onClick={back}>
        <ArrowLeft size={16} strokeWidth={1.65} aria-hidden />
        <span>返回工作台</span>
        <kbd>{shortcutText(desktopModeShortcuts.workspace)}</kbd>
      </button>
      <div className="management-machine">
        <span className="desktop-presence" data-online={facts.healthy || undefined} aria-hidden />
        <div>
          <strong>{machine ?? THIS_COMPUTER}</strong>
          <span>本机服务{facts.service}</span>
        </div>
      </div>
      {MANAGE_PAGES.map((id, index) => {
        const Icon = pageIcons[id];
        return (
          <button
            type="button"
            key={id}
            className="desktop-place management-nav-item"
            data-active={page === id || undefined}
            data-gap={index === 5 || undefined}
            aria-current={page === id ? "page" : undefined}
            onClick={() => navigate(id)}
          >
            <Icon size={16} strokeWidth={1.65} aria-hidden />
            <span>{managePageTitles[id]}</span>
            {id === "updates" && facts.newVersion && <span className="management-dot" aria-label="有新版本" />}
          </button>
        );
      })}
    </nav>
  );
}
