import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Icon } from "../icons";
import { engine, type Computer, type Connection } from "./engine";
import { ErrorNotice, Runtime, messageOf, useClient, useConnection } from "./common";
import { Screen } from "./Video";

export function Screens({ connect }: { connect: () => void }) {
  const computers = useStore(engine.state, (state) => state.computers);
  return (
    <div className="overview live-overview screens-overview">
      <div className="page-heading">
        <div>
          <h1>电脑屏幕</h1>
          <p className="host-summary">{computers.length} 台电脑 · {computers.filter((computer) => computer.machine.online).length} 台在线</p>
        </div>
        <button className="button secondary" onClick={connect}><Icon name="plus" />连接电脑</button>
      </div>
      {computers.length ? (
        <div className="screens-grid">
          {computers.map((computer) => <ScreenCard key={computer.key} computer={computer} />)}
        </div>
      ) : (
        <div className="empty-state"><Icon name="computer" size={40} /><h2>还没有连接的电脑</h2><p className="muted">连接电脑后，可以在这里同时观看它们的屏幕。</p><button className="button primary" onClick={connect}>连接电脑</button></div>
      )}
    </div>
  );
}

function ScreenCard({ computer }: { computer: Computer }) {
  const [connection, setConnection] = useState<Connection>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setConnection(undefined); setError(undefined);
    if (!computer.machine.online) return;
    try {
      const retained = engine.retainComputer(computer);
      setConnection(retained.connection);
      return retained.release;
    } catch (reason) { setError(messageOf(reason)); }
    // Presence changes manage the lease; name/metadata refreshes must not interrupt a viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computer.key, computer.machine.online]);
  return (
    <article className="screen-card" aria-label={`${computer.machine.name}的屏幕`}>
      <div className="screen-card-heading">
        <span className="screen-card-icon"><Icon name="computer" size={20} /></span>
        <h2>{computer.machine.name}</h2>
        <span className="screen-card-presence"><span className={computer.machine.online ? "online-dot" : "offline-dot"} />{computer.machine.online ? "在线" : "离线"}</span>
      </div>
      {connection && computer.machine.online ? (
        <Runtime value={connection}><ConnectedScreen name={computer.machine.name} /></Runtime>
      ) : (
        <div className="screen-card-placeholder"><Icon name="computer" size={44} /><strong>{computer.machine.online ? "正在连接电脑…" : "电脑离线"}</strong><p>{computer.machine.online ? "正在建立加密连接" : "电脑恢复在线后，即可开始观看"}</p><ErrorNotice error={error} /></div>
      )}
    </article>
  );
}

function ConnectedScreen({ name }: { name: string }) {
  const status = useClient((state) => state.status);
  const detail = useClient((state) => state.statusDetail);
  const { link } = useConnection();
  if (status === "online") return <Screen title={name} embedded />;
  return <div className="screen-card-placeholder"><Icon name="computer" size={44} /><strong>正在连接电脑…</strong><p>{detail ?? "正在建立加密连接"}</p><button className="text-button" onClick={() => link.reconnectNow()}>重新连接</button></div>;
}
