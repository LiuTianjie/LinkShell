import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { desktopInvoke, THIS_COMPUTER } from "./desktop";
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

/**
 * Pairing, as one settings row (what it is, why, the button) and, once a code is made, the code
 * under it in the same box. What happened to the last attempt follows the box as a footnote.
 */
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
    <>
      <div className="management-rows" role="group" aria-label="配对手机">
        <div className="management-row">
          <div className="management-setting-copy">
            <strong>连接你的手机</strong>
            <span>{loading ? "正在生成安全配对码…" : `扫描二维码或输入配对码，添加${THIS_COMPUTER}`}</span>
          </div>
          <div className="management-setting-control">
            {loading && <LoaderCircle className="animate-spin management-muted" size={16} aria-hidden />}
            <Button size="sm" variant={offer ? "secondary" : "default"} disabled={loading || disabled} onClick={() => void start()}>
              {offer ? "重新生成" : "配对新设备"}
            </Button>
          </div>
        </div>
        {offer && (
          <div className="management-row management-pairing-offer">
            {remaining > 0 && offer.qr
              ? <QrMatrix modules={offer.qr} />
              : <div className="management-qr-expired">{remaining > 0 ? "二维码不可用" : "已过期"}</div>}
            <div className="management-pairing-copy">
              {remaining > 0 ? (
                <>
                  <strong>在手机上打开「电脑 → 添加电脑」扫码</strong>
                  <span>或输入配对码</span>
                  <code className="management-pairing-code">{offer.code}</code>
                  <span>{`${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`} 后失效 · 请勿分享给他人</span>
                </>
              ) : (
                <>
                  <strong>配对码已过期</strong>
                  <span>点「重新生成」继续添加设备。</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {paired && <p className="management-footnote" data-tone="success" role="status"><CircleCheck size={14} aria-hidden />设备已配对</p>}
      {error && <p className="management-footnote management-selectable" data-tone="warning" role="alert">{error}</p>}
    </>
  );
}
