import { PageHeader } from "../components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LoaderCircle,
  RefreshCw,
  Search,
  LockKeyhole,
  X,
  ArrowLeft,
  Trash2,
  Palette,
} from "lucide-react";
import { useDialogs } from "@/components/Dialogs";
import { DESKTOP_LOCAL, isWindowsDesktop } from "./desktop";
import { RemoteScreen } from "./RemoteScreen";
import { ScreenConnectionLoading } from "./ScreenConnectionLoading";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Icon } from "../icons";
import { engine, type Computer, type Connection } from "./engine";
import { computerAtKey } from "./computer-identity";
import {
  EmptyState,
  ErrorNotice,
  Runtime,
  Modal,
  messageOf,
  useClient,
  useConnection,
} from "./common";
import { Screen, StatusDot } from "./Video";
import { ComputerName } from "./ComputerName";
import { ComputerMetrics, ComputerTelemetry } from "./ComputerTelemetry";
import { AccessUnlock } from "./Access";
import { computerVisualLabels, computerVisuals, useComputerVisuals, type ComputerVisual } from "./computer-visuals";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  computerName,
  computerIdentity,
  computerNames,
} from "./computer-names";

export function Screens({
  live = true,
  connect,
  open,
}: {
  /** False while the window is hidden: the page stays, sampling and card connections stop. */
  live?: boolean;
  connect: () => void;
  open: (computer: Computer) => void;
}) {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const computers = useStore(engine.state, (state) => state.computers);
  const { visuals, change } = useComputerVisuals(computers);
  const names = useStore(computerNames.store);
  const [query, setQuery] = useState("");
  const ready = useStore(engine.state, (state) => state.ready);
  const online = computers.filter((computer) => computer.machine.online).length;
  const search = query.trim().toLocaleLowerCase();
  const matches = (computer: Computer) =>
    [
      computerName(computer, names),
      computer.machine.name,
      computerIdentity(computer),
      computer.machine.id,
    ].some((value) => value.toLocaleLowerCase().includes(search));
  const found = computers.filter(matches).length;
  const searchField = (
    <InputGroup className="page-search">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="搜索电脑"
        placeholder="搜索名称或设备编号"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label="清除搜索" size="icon-xs" onClick={() => setQuery("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
  return (
    <div className="screens-page">
      <PageHeader
        title="我的电脑"
        detail={ready ? <><span>{computers.length} 台电脑</span><span>{online} 台在线</span></> : undefined}
        actions={<>
          {searchField}
          <Button size="sm" onClick={connect}><Icon name="plus" data-icon="inline-start" />连接电脑</Button>
        </>}
      />
      {!ready ? (
        <div className="computer-grid" role="status" aria-label="正在加载电脑">
          {[0, 1, 2].map((key) => (
            <div key={key} className="computer-card computer-card-loading">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-20 w-28" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-7 w-28 self-end" />
            </div>
          ))}
          <p className="screen-list-wait">
            <LoaderCircle className="animate-spin" aria-hidden />
            正在读取电脑…
          </p>
        </div>
      ) : computers.length ? (
        <div className="computer-grid">
          {!found && (
            <EmptyState
              icon={<Search />}
              title="没有找到这台电脑"
              description="试试电脑名称、系统名称或设备编号。"
            >
              <Button variant="outline" onClick={() => setQuery("")}>
                显示所有电脑
              </Button>
            </EmptyState>
          )}
          {computers.map((computer) => (
            <ScreenCard
              key={computer.key}
              computer={computer}
              live={live && visible}
              hidden={!matches(computer)}
              visual={visuals[computer.key] ?? "pixels"}
              changeVisual={(visual) => change(computer.key, visual)}
              open={() => open(computer)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Icon name="computer" size={18} />}
          title="还没有连接的电脑"
          description="连接你的电脑，查看运行状态，随时打开桌面。"
        >
          <Button onClick={connect}>连接电脑</Button>
        </EmptyState>
      )}
      {!!computers.length && (
        <p className="screen-note">
          <LockKeyhole size={13} aria-hidden />
          主机状态、画面与操作端到端加密
        </p>
      )}
    </div>
  );
}

function ScreenCard({
  computer,
  live,
  hidden,
  visual,
  changeVisual,
  open,
}: {
  computer: Computer;
  live: boolean;
  hidden: boolean;
  visual: ComputerVisual;
  changeVisual: (visual: ComputerVisual) => void;
  open: () => void;
}) {
  const selected = useStore(
    engine.state,
    (state) => state.connection?.computer.key === computer.key,
  );
  const names = useStore(computerNames.store);
  const name = computerName(computer, names);
  const watching = live && !hidden;
  const { connection, error, retry } = useScreenConnection(watching ? computer : undefined, computer.key, true);
  const { forget, forgetting } = useForget(computer);
  return (
    <section
      className="computer-card"
      hidden={hidden}
      data-current={selected || undefined}
      data-offline={!computer.machine.online || undefined}
      aria-label={name}
    >
      <header className="computer-card-header">
        <span className="computer-card-icon"><Icon name="computer" size={18} /></span>
        <div className="computer-card-name">
          <h2 title={name}>{name}</h2>
          <span title={`${computer.machine.name} · ${computer.machine.id}`}>{computer.key === DESKTOP_LOCAL ? "本机" : computerIdentity(computer)}</span>
        </div>
        {selected && <Badge variant="secondary">当前</Badge>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="computer-visual-menu" aria-label={`更换 ${name} 的仪表样式`} title="更换仪表样式"><Palette size={14} /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={visual} onValueChange={(value) => changeVisual(value as ComputerVisual)}>
              {computerVisuals.map((value) => <DropdownMenuRadioItem key={value} value={value}>{computerVisualLabels[value]}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ComputerName computer={computer} iconOnly />
      </header>
      {connection && computer.machine.online && watching ? (
        <Runtime value={connection}><ComputerTelemetry visual={visual} /></Runtime>
      ) : (
        <ComputerMetrics visual={visual} status={!computer.machine.online ? "电脑离线" : error ? "暂时无法连接" : live ? "正在连接电脑…" : "刷新已暂停"} detail={error} />
      )}
      <footer className="computer-card-footer">
        {connection && computer.machine.online && watching ? (
          <Runtime value={connection}>
            <ConnectedScreen name={name} primaryAction={selected} open={open} retry={retry} />
          </Runtime>
        ) : (
          <div className="screen-idle" role="status">
            <div className="screen-idle-status">
              <StatusDot on={false} />
              <div>
                <strong>
                  {error
                    ? "暂时无法连接"
                    : !computer.machine.online
                      ? "电脑离线"
                      : live
                        ? "正在连接电脑…"
                        : "画面已暂停"}
                </strong>
                <span title={error}>
                  {error ??
                    (!computer.machine.online
                      ? "电脑开机并运行 LinkShell 后即可连接"
                      : live
                        ? "正在建立加密连接"
                        : "窗口回到前台后继续")}
                </span>
              </div>
            </div>
            <div className="screen-idle-actions">
              {error && (
                <Button variant="outline" onClick={retry}>
                  <RefreshCw data-icon="inline-start" />
                  重新连接
                </Button>
              )}
              {!computer.machine.online && computer.key !== DESKTOP_LOCAL && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`移除 ${name}`}
                  title="移除这台电脑"
                  disabled={forgetting}
                  onClick={forget}
                >
                  <Trash2 />
                </Button>
              )}
              {!computer.machine.online && (
                <Button variant="outline" onClick={() => engine.reconnect()}>
                  <RefreshCw data-icon="inline-start" />
                  刷新连接
                </Button>
              )}
            </div>
          </div>
        )}
      </footer>
    </section>
  );
}

function ConnectedScreen({
  name,
  primaryAction,
  open,
  detail = false,
  active = true,
  retry,
}: {
  name: string;
  primaryAction?: boolean;
  open?: () => void;
  detail?: boolean;
  active?: boolean;
  retry?: () => void;
}) {
  const status = useClient((state) => state.status);
  const statusDetail = useClient((state) => state.statusDetail);
  const { link } = useConnection();
  const [unlocking, setUnlocking] = useState(false);
  useEffect(() => { if (status !== "locked") setUnlocking(false); }, [status]);
  if (status === "locked") return detail ? <AccessUnlock name={name} /> : (
    <div className="screen-idle">
      <div className="screen-idle-status"><LockKeyhole size={14} /><div><strong>需要访问密码</strong><span>解锁后查看负载与桌面</span></div></div>
      <div className="screen-idle-actions"><Button variant="outline" onClick={() => setUnlocking(true)}>解锁电脑</Button></div>
      {unlocking && <Modal title="解锁电脑" close={() => setUnlocking(false)}><AccessUnlock name={name} /></Modal>}
    </div>
  );
  if (status === "online")
    return (
      <Screen
        title={name}
        embedded={!detail}
        primaryAction={primaryAction}
        onOpen={open}
        autoStart={detail}
        active={active}
      />
    );
  return (
    <div className="screen-idle" role="status">
      <div className="screen-idle-status">
        {status === "connecting" || status === "reconnecting" ? (
          <LoaderCircle className="shrink-0 animate-spin text-muted-foreground" size={14} />
        ) : (
          <StatusDot on={false} />
        )}
        <div>
          <strong>
            {status === "stopped"
              ? "连接已断开"
              : status === "reconnecting"
                ? "正在恢复连接…"
                : "正在连接电脑…"}
          </strong>
          <span>
            {statusDetail ?? "正在建立加密连接"}
          </span>
        </div>
      </div>
      <div className="screen-idle-actions">
        <Button variant="outline" onClick={retry ?? (() => link.reconnectNow())}>
          重新连接
        </Button>
      </div>
    </div>
  );
}

/** The desktop window's remote screen, once the computer's connection is up. */
function RemoteScreenConnection({ name, active, back, retry }: { name: string; active: boolean; back: () => void; retry: () => void }) {
  const status = useClient((state) => state.status);
  const statusDetail = useClient((state) => state.statusDetail);
  if (status === "online") return <RemoteScreen title={name} active={active} back={back} />;
  return (
    <div className="remote-screen remote-screen-waiting">
      <div className="remote-screen-bar">
        <div className="remote-screen-title">
          <Button variant="ghost" size="icon" aria-label="返回我的电脑" title="返回我的电脑" onClick={back}><ArrowLeft /></Button>
          <strong>{name}</strong>
        </div>
      </div>
      <div className="remote-screen-stage">
        <div className="remote-screen-overlay">
          <ScreenConnectionLoading
            preparing={false}
            slow={status === "stopped"}
            error={status === "stopped" ? statusDetail ?? "连接已断开" : undefined}
            retry={retry}
          />
        </div>
      </div>
    </div>
  );
}

/** Takes a computer off the list: its pairing, or, for one that signed in to the account, the account. */
function useForget(computer: Computer | undefined, done?: () => void) {
  const dialogs = useDialogs();
  const names = useStore(computerNames.store);
  const [forgetting, setForgetting] = useState(false);
  const forget = async () => {
    if (!computer) return;
    const confirmed = await dialogs.confirm(
      `从列表中移除「${computerName(computer, names)}」？之后可以在那台电脑上重新登录或配对。`,
    );
    if (!confirmed) return;
    setForgetting(true);
    try {
      await engine.forget(computer);
      done?.();
    } catch (reason) {
      engine.report(reason);
    } finally {
      setForgetting(false);
    }
  };
  return { forget: () => void forget(), forgetting };
}

function useScreenConnection(computer?: Computer, identity = computer?.key, metadataOnly = false) {
  const [connection, setConnection] = useState<Connection>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setConnection(undefined);
    setError(undefined);
    if (!computer?.machine.online) return;
    try {
      const retained = engine.retainComputer(computer, { metadataOnly });
      setConnection(retained.connection);
      return retained.release;
    } catch (reason) {
      setError(messageOf(reason));
    }
    // An alias changing from relay to local must not replace a live viewer's transport.
    // Retry explicitly acquires the preferred route; presence still releases an offline host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, computer?.machine.online, metadataOnly, revision]);
  return { connection, error, retry: () => {
    const preferred = computer && engine.computerForKey(computer.key);
    if (connection && preferred?.key === connection.computer.key) connection.link.reconnectNow();
    else setRevision((value) => value + 1);
  } };
}

export function ScreenDetail({
  computerKey,
  back,
  active = true,
}: {
  computerKey: string;
  back: () => void;
  active?: boolean;
}) {
  const computer = useStore(engine.state, (state) =>
    computerAtKey(state.computers, computerKey, state.localComputer),
  );
  const ready = useStore(engine.state, (state) => state.ready);
  const names = useStore(computerNames.store);
  const { connection, error, retry } = useScreenConnection(computer, computerKey);
  const { forget, forgetting } = useForget(computer, back);
  const selectedKey = useStore(engine.state, (state) => state.connection &&
    computerAtKey(state.computers, state.connection.computer.key, state.localComputer)?.key,
  );
  useEffect(() => {
    if (!active || !computer?.machine.online || selectedKey === computer.key) return;
    try {
      engine.select(computer);
    } catch (reason) {
      engine.report(reason);
    }
  }, [active, computer, selectedKey]);
  const name = computer ? computerName(computer, names) : "远程桌面";
  // The desktop window gives the screen the whole panel: its own bar is the page's title row.
  if (isWindowsDesktop && ready && computer?.machine.online && connection && !error)
    return (
      <div className="screen-detail-page remote-screen-page">
        <Runtime value={connection}>
          <RemoteScreenConnection name={name} active={active} back={back} retry={retry} />
        </Runtime>
      </div>
    );
  return (
    <div className="screen-detail-page">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="返回我的电脑"
            title="返回我的电脑"
            onClick={back}
          >
            <ArrowLeft />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">{name}</h1>
            {computer && (
              <p className="truncate text-xs text-muted-foreground">
                {computerIdentity(computer)}
              </p>
            )}
          </div>
        </div>
        {computer && <ComputerName computer={computer} />}
      </header>
      {!ready ? (
        <Skeleton className="h-96 w-full" />
      ) : !computer ? (
        <EmptyState
          title="暂未找到这台电脑"
          description="确认电脑仍在当前账号或配对列表中。"
        >
          <Button variant="outline" onClick={back}>
            返回我的电脑
          </Button>
        </EmptyState>
      ) : !computer.machine.online ? (
        <EmptyState
          title="电脑已离线"
          description="电脑开机并运行 LinkShell 后即可连接。"
        >
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => engine.reconnect()}>
              刷新连接
            </Button>
            {computer.key !== DESKTOP_LOCAL && (
              <Button variant="ghost" disabled={forgetting} onClick={forget}>
                <Trash2 data-icon="inline-start" />
                移除这台电脑
              </Button>
            )}
          </div>
        </EmptyState>
      ) : error ? (
        <EmptyState title="暂时无法连接">
          <ErrorNotice error={error} />
          <Button variant="outline" onClick={retry}>
            重新连接
          </Button>
        </EmptyState>
      ) : connection ? (
        <Runtime value={connection}>
          <ConnectedScreen name={name} detail active={active} retry={retry} />
        </Runtime>
      ) : (
        <Skeleton className="h-96 w-full" />
      )}
    </div>
  );
}
