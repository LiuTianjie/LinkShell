import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
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
import "./connection-polish.css";

export function Screens({ connect }: { connect: () => void }) {
  const computers = useStore(engine.state, (state) => state.computers);
  const ready = useStore(engine.state, (state) => state.ready);
  const online = computers.filter((computer) => computer.machine.online).length;
  return (
    <div className="overview live-overview screens-overview">
      <div className="page-heading">
        <div>
          <span className="page-eyebrow">远程工作空间</span>
          <h1>电脑屏幕</h1>
          <p className="host-summary">查看电脑桌面，或打开全屏继续远程操作。</p>
        </div>
        <Button variant="outline" onClick={connect}>
          <Icon name="plus" />
          连接电脑
        </Button>
      </div>
      <div className="screens-summary">
        <span>
          <span className={online ? "online-dot" : "screen-idle-dot"} />
          {online} 台在线
        </span>
        <span>{computers.length} 台电脑</span>
        <span className="screens-summary-hint">选择画质与帧率，再开始观看</span>
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
          {computers.map((computer) => (
            <ScreenCard key={computer.key} computer={computer} />
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
    </div>
  );
}

function ScreenCard({ computer }: { computer: Computer }) {
  const [connection, setConnection] = useState<Connection>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setConnection(undefined);
    setError(undefined);
    if (!computer.machine.online) return;
    try {
      const retained = engine.retainComputer(computer);
      setConnection(retained.connection);
      return retained.release;
    } catch (reason) {
      setError(messageOf(reason));
    }
    // Presence changes manage the lease; name/metadata refreshes must not interrupt a viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computer.key, computer.machine.online, revision]);
  return (
    <Card
      className="screen-card gap-0 py-0"
      aria-label={`${computer.machine.name}的屏幕`}
    >
      <CardHeader className="screen-card-heading flex items-center">
        <span className="screen-card-icon">
          <Icon name="computer" size={20} />
        </span>
        <CardTitle
          className="min-w-0 flex-1 truncate"
          title={computer.machine.name}
        >
          {computer.machine.name}
        </CardTitle>
        <CardAction className="self-center">
          <Badge variant={computer.machine.online ? "success" : "secondary"}>
            {computer.machine.online ? "在线" : "离线"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {connection && computer.machine.online ? (
          <Runtime value={connection}>
            <ConnectedScreen name={computer.machine.name} />
          </Runtime>
        ) : (
          <div className="screen-card-placeholder" role="status">
            <Icon name="computer" size={44} />
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
                : "请确认电脑已开机、联网，并运行 LinkShell。恢复在线后将自动连接。"}
            </p>
            <ErrorNotice error={error} />
            {error && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRevision((value) => value + 1)}
              >
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

function ConnectedScreen({ name }: { name: string }) {
  const status = useClient((state) => state.status);
  const detail = useClient((state) => state.statusDetail);
  const { link } = useConnection();
  if (status === "online") return <Screen title={name} embedded />;
  return (
    <div className="screen-card-placeholder" role="status">
      {status === "connecting" || status === "reconnecting" ? (
        <LoaderCircle className="animate-spin" size={32} />
      ) : (
        <Icon name="computer" size={44} />
      )}
      <strong>
        {status === "stopped"
          ? "连接已断开"
          : status === "reconnecting"
            ? "正在恢复连接…"
            : "正在连接电脑…"}
      </strong>
      <p>{detail ?? "正在建立加密连接"}</p>
      <Button variant="link" size="sm" onClick={() => link.reconnectNow()}>
        重新连接
      </Button>
    </div>
  );
}
