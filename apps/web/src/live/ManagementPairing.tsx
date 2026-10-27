import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, QrCode, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { desktopInvoke } from "./desktop";
import type { DesktopDevice, PairingOffer } from "./management-model";

/** The QR matrix `pair-qr` returns, drawn as one path so it stays sharp at any zoom. */
function QrMatrix({ modules }: { modules: boolean[][] }) {
  const size = modules.length;
  const path = useMemo(() => {
    let d = "";
    modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
    return d;
  }, [modules]);
  // A four-module quiet zone, as the QR specification asks; scanners need it.
  return (
    <svg className="management-qr" viewBox={`0 0 ${size + 8} ${size + 8}`} role="img" aria-label="设备配对二维码" shapeRendering="crispEdges">
      <path d={path} />
    </svg>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function ManagementPairing({ devices, disabled }: { devices: DesktopDevice[]; disabled: boolean }) {
  const [offer, setOffer] = useState<PairingOffer>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [paired, setPaired] = useState(false);
  const known = useRef<Set<string>>(new Set());
  const now = useNow(!!offer);
  const remaining = offer ? Math.max(0, Math.floor((offer.expiresAt - now) / 1000)) : 0;

  // A device that was not there when the code was made is the one that just paired.
  const ids = devices.map((device) => device.id).join("\n");
  useEffect(() => {
    if (!offer) return;
    if (ids.split("\n").some((id) => id && !known.current.has(id))) {
      setOffer(undefined);
      setPaired(true);
    }
  }, [ids, offer]);

  const start = async () => {
    setLoading(true); setError(undefined); setPaired(false); setOffer(undefined);
    known.current = new Set(devices.map((device) => device.id));
    try { setOffer(await desktopInvoke<PairingOffer>("action", { name: "pair-qr" })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setLoading(false); }
  };

  return (
    <section className="management-pairing" aria-label="配对手机">
      <div className="management-pairing-head">
        <span className="management-pairing-icon" aria-hidden><QrCode size={16} /></span>
        <div>
          <h2>连接你的手机</h2>
          <p>扫描二维码或输入配对码，添加这台 Mac</p>
        </div>
        <Button variant={offer ? "outline" : "default"} disabled={loading || disabled} onClick={() => void start()}>
          {offer ? "重新生成" : "配对新设备"}
        </Button>
      </div>
      {loading && <p className="management-note" role="status"><LoaderCircle className="animate-spin" size={14} />正在生成安全配对码…</p>}
      {paired && <p className="management-note" data-tone="success" role="status"><CircleCheck size={14} />设备已配对</p>}
      {error && <p className="management-note" data-tone="warning" role="alert">{error}</p>}
      {offer ? (
        <div className="management-pairing-offer">
          {remaining > 0 && offer.qr
            ? <QrMatrix modules={offer.qr} />
            : <div className="management-qr-expired">{remaining > 0 ? "二维码不可用" : "已过期"}</div>}
          <div className="management-pairing-copy">
            <strong>{remaining > 0 ? "在 LinkShell 手机端扫描" : "配对码已过期"}</strong>
            {remaining > 0 ? (
              <>
                <span>也可以输入配对码</span>
                <code className="management-pairing-code">{offer.code}</code>
                <span>{`${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`} 后失效 · 请勿分享给他人</span>
              </>
            ) : <span>点击「重新生成」继续添加设备。</span>}
            <span className="management-mono">{offer.gateway}</span>
          </div>
        </div>
      ) : !paired && (
        <p className="management-hint">同账号登录可自动发现；设备配对独立于账号。免登录配对需连接自建网关，官方网关需要 Pro 账号。</p>
      )}
    </section>
  );
}
