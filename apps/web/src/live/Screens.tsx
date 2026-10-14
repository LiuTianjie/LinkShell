import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
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
} from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import { Icon } from "../icons";
import { engine, type Computer, type Connection } from "./engine";
import {
  EmptyState,
  ErrorNotice,
  Runtime,
  messageOf,
  useClient,
  useConnection,
} from "./common";
import { Screen } from "./Video";
import { ComputerName } from "./ComputerName";
import {
  computerName,
  computerIdentity,
  computerNames,
} from "./computer-names";
import "./connection-polish.css";

export function Screens({
  connect,
  open,
}: {
  connect: () => void;
  open: (computer: Computer) => void;
}) {
  const computers = useStore(engine.state, (state) => state.computers);
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
  return (
    <div className="overview live-overview screens-overview">
      <div className="page-heading">
        <div>
          <h1>远程桌面</h1>
          <p className="host-summary">连接你的电脑，继续手边的工作。</p>
        </div>
        <Button onClick={connect}>
          <Icon name="plus" data-icon="inline-start" />
          连接电脑
        </Button>
      </div>
      <div className="screens-collection-toolbar">
        <div className="screens-summary">
          <h2>
            {search ? "搜索结果" : "所有电脑"}{" "}
            <span>{search ? found : computers.length}</span>
          </h2>
          <span>
            <span className={online ? "online-dot" : "screen-idle-dot"} />
            {online} 台在线
          </span>
        </div>
        <InputGroup className="screens-search w-full sm:w-[240px]">
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
              <InputGroupButton
                aria-label="清除搜索"
                size="icon-xs"
                onClick={() => setQuery("")}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      {!ready ? (
        <div className="screens-grid" role="status" aria-label="正在加载电脑">
          {[0, 1].map((key) => (
            <Card key={key} className="gap-0 py-0">
              <CardHeader>
                <Skeleton className="h-5 w-40" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-64 w-full" />
              </CardContent>
            </Card>
          ))}
          <span className="sr-only">正在加载电脑…</span>
        </div>
      ) : computers.length ? (
        <div className="screens-grid">
          {!found && (
            <EmptyState
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
              hidden={!matches(computer)}
              open={() => open(computer)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="还没有连接的电脑"
          description="连接电脑后，可以在这里打开它们的屏幕。"
        >
          <Button onClick={connect}>连接电脑</Button>
        </EmptyState>
      )}
      {!!computers.length && (
        <div className="screens-collection-note">
          <span>
            <LockKeyhole size={13} />
            端到端加密连接
          </span>
          <span>点击名称旁的铅笔，为电脑起个好认的名字</span>
        </div>
      )}
    </div>
  );
}

function ScreenCard({
  computer,
  hidden,
  open,
}: {
  computer: Computer;
  hidden: boolean;
  open: () => void;
}) {
  const selected = useStore(
    engine.state,
    (state) => state.connection?.computer.key === computer.key,
  );
  const names = useStore(computerNames.store);
  const name = computerName(computer, names);
  const { connection, error, retry } = useScreenConnection(computer);
  return (
    <Card
      className={cn(
        "screen-card grid gap-0 rounded-none px-[24px] py-[18px] ring-0",
        hidden && "hidden",
      )}
      data-current={selected || undefined}
      aria-label={`${name}的屏幕`}
    >
      <CardHeader className="screen-card-heading flex items-center gap-4 px-0">
        <span className="screen-card-icon">
          <Icon name="computer" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="screen-device-title">
            <CardTitle className="truncate" title={name}>
              {name}
            </CardTitle>
            {selected && <Badge variant="secondary">当前</Badge>}
            <ComputerName computer={computer} iconOnly />
          </div>
          <CardDescription
            className="truncate"
            title={`${computer.machine.name} · ${computer.machine.id}`}
          >
            {names[computer.key] && (
              <>
                {computer.machine.name}
                <span aria-hidden="true"> · </span>
              </>
            )}
            {computerIdentity(computer)}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {connection && computer.machine.online ? (
          <Runtime value={connection}>
            <ConnectedScreen name={name} primaryAction={selected} open={open} />
          </Runtime>
        ) : (
          <div className="screen-card-placeholder" role="status">
            <div className="screen-connection-copy">
              <strong>
                {error
                  ? "暂时无法连接"
                  : computer.machine.online
                    ? "正在连接电脑…"
                    : "电脑离线"}
              </strong>
              <p>
                {computer.machine.online
                  ? "正在建立加密连接"
                  : "电脑开机并运行 LinkShell 后即可连接"}
              </p>
              <ErrorNotice error={error} />
            </div>
            {error && (
              <Button variant="outline" size="sm" onClick={retry}>
                <RefreshCw data-icon="inline-start" />
                重新连接
              </Button>
            )}
            {!computer.machine.online && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => engine.reconnect()}
              >
                <RefreshCw data-icon="inline-start" />
                刷新连接
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectedScreen({
  name,
  primaryAction,
  open,
  detail = false,
}: {
  name: string;
  primaryAction?: boolean;
  open?: () => void;
  detail?: boolean;
}) {
  const status = useClient((state) => state.status);
  const statusDetail = useClient((state) => state.statusDetail);
  const { link } = useConnection();
  if (status === "online")
    return (
      <Screen
        title={name}
        embedded={!detail}
        primaryAction={primaryAction}
        onOpen={open}
        autoStart={detail}
      />
    );
  return (
    <div className="screen-card-placeholder" role="status">
      {status === "connecting" || status === "reconnecting" ? (
        <LoaderCircle className="animate-spin" size={32} />
      ) : (
        <Icon name="computer" size={20} />
      )}
      <strong>
        {status === "stopped"
          ? "连接已断开"
          : status === "reconnecting"
            ? "正在恢复连接…"
            : "正在连接电脑…"}
      </strong>
      <p>{statusDetail ?? "正在建立加密连接"}</p>
      <Button variant="link" size="sm" onClick={() => link.reconnectNow()}>
        重新连接
      </Button>
    </div>
  );
}

function useScreenConnection(computer?: Computer) {
  const [connection, setConnection] = useState<Connection>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setConnection(undefined);
    setError(undefined);
    if (!computer?.machine.online) return;
    try {
      const retained = engine.retainComputer(computer);
      setConnection(retained.connection);
      return retained.release;
    } catch (reason) {
      setError(messageOf(reason));
    }
    // Presence changes manage the lease; name/metadata refreshes must not interrupt a viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computer?.key, computer?.machine.online, revision]);
  return { connection, error, retry: () => setRevision((value) => value + 1) };
}

export function ScreenDetail({
  computerKey,
  back,
}: {
  computerKey: string;
  back: () => void;
}) {
  const computer = useStore(engine.state, (state) =>
    state.computers.find((item) => item.key === computerKey),
  );
  const ready = useStore(engine.state, (state) => state.ready);
  const names = useStore(computerNames.store);
  const { connection, error, retry } = useScreenConnection(computer);
  const selectedKey = useStore(
    engine.state,
    (state) => state.connection?.computer.key,
  );
  useEffect(() => {
    if (!computer?.machine.online || selectedKey === computer.key) return;
    try {
      engine.select(computer);
    } catch (reason) {
      engine.report(reason);
    }
  }, [computer, selectedKey]);
  const name = computer ? computerName(computer, names) : "远程桌面";
  return (
    <div className="screen-detail-page">
      <header className="screen-detail-heading">
        <div className="screen-detail-identity">
          <Button
            variant="ghost"
            size="icon"
            aria-label="返回电脑列表"
            title="返回电脑列表"
            onClick={back}
          >
            <ArrowLeft />
          </Button>
          <div>
            <h1>{name}</h1>
            {computer && <p>{computerIdentity(computer)}</p>}
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
            返回电脑列表
          </Button>
        </EmptyState>
      ) : !computer.machine.online ? (
        <EmptyState
          title="电脑已离线"
          description="电脑开机并运行 LinkShell 后即可连接。"
        >
          <Button variant="outline" onClick={() => engine.reconnect()}>
            刷新连接
          </Button>
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
          <ConnectedScreen name={name} detail />
        </Runtime>
      ) : (
        <Skeleton className="h-96 w-full" />
      )}
    </div>
  );
}
