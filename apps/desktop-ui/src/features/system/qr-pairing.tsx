import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  createLocalPairingOffer,
  useManagement,
  type DesktopDevice,
  type PairingOffer,
} from "../../core";
import { DesktopIcon } from "../../icons";
import {
  Button,
  CopyButton,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../primitives";
import { useSystemI18n } from "./system-i18n";

const EMPTY_DEVICES: DesktopDevice[] = [];

/**
 * Renders `PairingOffer.qr` (`boolean[][]`) as a single crisp SVG path inside a
 * light `#ffffff` quiet-zone chip so phone cameras scan reliably in both Light and Dark themes.
 */
export function QrMatrixSvg({
  modules,
  label,
}: {
  modules: boolean[][];
  label: string;
}) {
  const size = modules.length;
  const path = useMemo(() => {
    let d = "";
    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`;
      });
    });
    return d;
  }, [modules]);

  return (
    <svg
      viewBox={`0 0 ${size + 8} ${size + 8}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <path d={path} />
    </svg>
  );
}

function useSecondTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function formatCountdownMmSs(remainingSeconds: number): string {
  const clamped = Math.max(0, Math.floor(remainingSeconds));
  const minutes = String(Math.floor(clamped / 60)).padStart(2, "0");
  const seconds = String(clamped % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function PairingOfferCard({
  offer,
  remainingSeconds,
  variant = "inline",
  onRegenerate,
  regenerating = false,
}: {
  offer: PairingOffer;
  remainingSeconds: number;
  variant?: "inline" | "dialog";
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  const { ts } = useSystemI18n();
  const expired = remainingSeconds <= 0;

  return (
    <div
      className={
        variant === "dialog" ? "ls-qr-offer ls-qr-offer--dialog" : "ls-qr-offer"
      }
    >
      {!expired && offer.qr && offer.qr.length > 0 ? (
        <div className="ls-qr-chip">
          <QrMatrixSvg modules={offer.qr} label={ts("localPairDialog.title")} />
        </div>
      ) : (
        <div className="ls-qr-chip ls-qr-chip--expired">
          {expired ? ts("devices.qrExpired") : ts("devices.qrUnavailable")}
        </div>
      )}

      <div className="ls-qr-offer__copy">
        {!expired ? (
          <>
            <strong className="ls-qr-offer__title">
              {ts("devices.qrInstruction")}
            </strong>
            <span className="ls-system-row__detail">{ts("devices.qrCodeHint")}</span>
            <div className="ls-qr-offer__code-row">
              <code className="ls-qr-offer__code">{offer.code}</code>
              <CopyButton value={offer.code} showText />
            </div>
            <span className="ls-qr-offer__timer">
              {ts("devices.qrExpiresIn", {
                time: formatCountdownMmSs(remainingSeconds),
              })}
            </span>
          </>
        ) : (
          <>
            <strong className="ls-qr-offer__title">{ts("devices.qrExpired")}</strong>
            <span className="ls-system-row__detail">
              {ts("devices.qrExpiredHint")}
            </span>
            {onRegenerate ? (
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={regenerating}
                  onClick={onRegenerate}
                >
                  {ts("devices.regenerateBtn")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Inline local Host pairing card for `SystemDevicesPage`: generates a 6-digit code + QR matrix
 * and automatically marks pairing complete as soon as a new device appears in `snapshot.gateway.devices`.
 */
export function LocalPairingSection({
  devices,
  disabled = false,
}: {
  devices: DesktopDevice[];
  disabled?: boolean;
}) {
  const { ts } = useSystemI18n();
  const offer = useManagement((s) => s.pairingOffer);
  const loading = useManagement((s) => s.pairingLoading);
  const error = useManagement((s) => s.pairingError);
  const [justPaired, setJustPaired] = useState(false);
  const baselineDeviceIds = useRef<Set<string> | null>(null);

  const now = useSecondTicker(Boolean(offer));
  const remaining = offer ? Math.max(0, Math.floor((offer.expiresAt - now) / 1000)) : 0;

  const deviceKey = devices.map((d) => d.id).join("\n");
  useEffect(() => {
    if (!offer || !baselineDeviceIds.current) return;
    const known = baselineDeviceIds.current;
    const added = devices.some((d) => d.id && !known.has(d.id));
    if (added) {
      baselineDeviceIds.current = null;
      setJustPaired(true);
    }
  }, [deviceKey, devices, offer]);

  const handleGenerate = async () => {
    setJustPaired(false);
    baselineDeviceIds.current = new Set(devices.map((d) => d.id));
    await createLocalPairingOffer();
  };

  return (
    <>
      <div className="ls-system-card" role="group" aria-label={ts("devices.addGroup")}>
        <div className="ls-system-row">
          <div className="ls-system-row__copy">
            <span className="ls-system-row__title">
              <DesktopIcon name="pair-qr" size="sm" />
              {ts("devices.pairRowTitle")}
            </span>
            <span className="ls-system-row__detail">
              {loading ? ts("devices.pairRowGenerating") : ts("devices.pairRowDetail")}
            </span>
          </div>
          <div className="ls-system-row__controls">
            <Button
              size="sm"
              variant={offer ? "secondary" : "primary"}
              loading={loading}
              disabled={disabled}
              onClick={() => void handleGenerate()}
            >
              {offer ? ts("devices.regenerateBtn") : ts("devices.generateBtn")}
            </Button>
          </div>
        </div>

        {offer && !justPaired ? (
          <PairingOfferCard
            offer={offer}
            remainingSeconds={remaining}
            onRegenerate={() => void handleGenerate()}
            regenerating={loading}
          />
        ) : null}
      </div>

      {justPaired ? (
        <p className="ls-system-note" data-tone="ok" role="status">
          {ts("devices.justPaired")}
        </p>
      ) : null}
      {error ? (
        <p className="ls-system-note" data-tone="danger" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * Standalone top-anchored `420px` Local Pairing QR Dialog (`#18` locked export),
 * triggered from the Sidebar or Command Center to pair a phone in one click.
 */
export function LocalPairingQrDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { open, onOpenChange } = props;
  const { ts } = useSystemI18n();
  const offer = useManagement((s) => s.pairingOffer);
  const loading = useManagement((s) => s.pairingLoading);
  const error = useManagement((s) => s.pairingError);
  const devices = useManagement(
    (s) => s.snapshot?.gateway?.devices ?? EMPTY_DEVICES,
  );
  const baselineIds = useRef<Set<string> | null>(null);

  const now = useSecondTicker(open && Boolean(offer));
  const remaining = offer ? Math.max(0, Math.floor((offer.expiresAt - now) / 1000)) : 0;

  useEffect(() => {
    if (!open) {
      baselineIds.current = null;
      return;
    }
    baselineIds.current = new Set(devices.map((d) => d.id));
    if (!offer || offer.expiresAt <= Date.now() + 15_000) {
      void createLocalPairingOffer();
    }
    // Intentionally run when dialog transitions to open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const deviceIdsKey = devices.map((d) => d.id).join("\n");
  useEffect(() => {
    if (!open || !baselineIds.current) return;
    const known = baselineIds.current;
    if (devices.some((d) => d.id && !known.has(d.id))) {
      onOpenChange(false);
    }
  }, [deviceIdsKey, devices, onOpenChange, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      size="sm"
      dismissible
      unmountWhenClosed
      className="ls-local-pair-dialog"
    >
      <DialogHeader
        onClose={() => onOpenChange(false)}
        closeLabel={ts("modal.close")}
      >
        <DialogTitle>{ts("localPairDialog.title")}</DialogTitle>
        <DialogDescription>{ts("localPairDialog.desc")}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {offer ? (
          <PairingOfferCard
            offer={offer}
            remainingSeconds={remaining}
            variant="dialog"
            regenerating={loading}
            onRegenerate={() => void createLocalPairingOffer()}
          />
        ) : loading ? (
          <div className="ls-signin-waiting" role="status">
            <DesktopIcon name="spinner" size="lg" />
            <p>{ts("devices.pairRowGenerating")}</p>
          </div>
        ) : null}
        {error ? (
          <p className="ls-system-note" data-tone="danger" role="alert">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button
          variant="secondary"
          loading={loading}
          onClick={() => void createLocalPairingOffer()}
        >
          {ts("devices.regenerateBtn")}
        </Button>
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          {ts("modal.close")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
