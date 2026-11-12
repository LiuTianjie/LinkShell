import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { decodePairingLink } from "@linkshell/wire";
import { Camera, CheckCircle2, CircleAlert, ImageUp, LoaderCircle, QrCode, X } from "lucide-react";

export function Scan({
  found,
  disabled = false,
}: {
  found: (link: string) => void;
  disabled?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState(false);
  // Camera scanning only makes sense where there's a camera — hide it on
  // desktops (where it just errors) and show image drop/paste/pick as the primary way.
  const [hasCamera, setHasCamera] = useState(false);
  const [starting, setStarting] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string>();
  const callback = useRef(found);
  const disabledRef = useRef(disabled);
  const readingRef = useRef(reading);
  const operation = useRef(0);
  const accepted = useRef(false);
  callback.current = found;
  disabledRef.current = disabled;
  readingRef.current = reading;

  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    // A touch device with a camera is the realistic place to scan a QR code;
    // treat fine-pointer (desktop) devices as camera-less for this flow.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (!touch || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices().then(
      (devices) => {
        if (alive) setHasCamera(devices.some((d) => d.kind === "videoinput"));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  function accept(text: string) {
    if (accepted.current || disabledRef.current) return;
    if (!decodePairingLink(text)) {
      setError("不是有效的 LinkShell 配对二维码，请扫描 linkshell pair 生成的二维码");
      setSuccess(false);
      return;
    }
    accepted.current = true;
    callback.current(text.trim());
    setCamera(false);
    setSuccess(true);
    setError(undefined);
  }
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  function scanImageFile(file: File) {
    if (disabledRef.current || readingRef.current) return;
    const current = ++operation.current;
    accepted.current = false;
    setCamera(false);
    setReading(true);
    setSuccess(false);
    setError(undefined);
    void import("qr-scanner")
      .then((module) =>
        module.default.scanImage(file, {
          returnDetailedScanResult: true,
        }),
      )
      .then(
        (result) => {
          if (current === operation.current) acceptRef.current(result.data);
        },
        () => {
          if (current === operation.current) {
            setError("未识别到二维码，请选择清晰的二维码截图或手动输入配对码");
          }
        },
      )
      .finally(() => {
        if (current === operation.current) setReading(false);
      });
  }
  const scanImageFileRef = useRef(scanImageFile);
  scanImageFileRef.current = scanImageFile;

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (disabledRef.current || readingRef.current) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            scanImageFileRef.current(file);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    if (!camera || disabled || !video.current) return;
    let closed = false;
    let scanner: import("qr-scanner").default | undefined;
    void import("qr-scanner")
      .then(async ({ default: QrScanner }) => {
        if (closed || !video.current) return;
        scanner = new QrScanner(
          video.current,
          (result) => {
            if (!closed) acceptRef.current(result.data);
          },
          {
            preferredCamera: "environment",
            returnDetailedScanResult: true,
            highlightScanRegion: true,
          },
        );
        await scanner.start();
        if (!closed) setStarting(false);
      })
      .catch(() => {
        if (!closed) {
          setError("无法打开摄像头，请检查权限或选择二维码图片");
          setCamera(false);
          setStarting(false);
        }
      });
    return () => {
      closed = true;
      scanner?.destroy();
    };
  }, [camera, disabled]);

  const pickFile = () => {
    if (disabled || reading || !fileInput.current) return;
    fileInput.current.value = "";
    fileInput.current.click();
  };

  const tone = error ? "danger" : success ? "ok" : undefined;

  return (
    <div className="qr-scan">
      <div
        className="qr-dropzone"
        data-dragging={dragging || undefined}
        data-tone={tone}
        data-disabled={disabled || reading || undefined}
        onDragEnter={(event) => {
          if (disabled || reading) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (disabled || reading) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled || reading) return;
          const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
          if (file) scanImageFile(file);
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          pickFile();
        }}
      >
        <span className="qr-dropzone-mark" aria-hidden>
          {reading ? (
            <LoaderCircle className="animate-spin" />
          ) : error ? (
            <CircleAlert />
          ) : success ? (
            <CheckCircle2 />
          ) : (
            <QrCode />
          )}
        </span>
        <div
          className="qr-dropzone-copy"
          role={error ? "alert" : reading || success ? "status" : undefined}
        >
          <strong>
            {reading
              ? "正在读取二维码图片…"
              : error
                ? "未能识别二维码"
                : success
                  ? "已读取配对二维码"
                  : "二维码快速识别"}
          </strong>
          <span>
            {reading
              ? "正在解析配对链接与网关地址"
              : error
                ? error
                : success
                  ? "配对信息已自动填入，点击下方按钮即可连接"
                  : "拖入截图、直接粘贴图片，或点击选择"}
          </span>
        </div>
        <div className="qr-dropzone-actions">
          {hasCamera && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={disabled || reading}
              aria-expanded={camera && !disabled}
              onClick={() => {
                accepted.current = false;
                setSuccess(false);
                setError(undefined);
                setStarting(!camera);
                setCamera(!camera);
              }}
            >
              {camera ? <X data-icon="inline-start" /> : <Camera data-icon="inline-start" />}
              {camera ? "关闭" : "扫码"}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={disabled || reading}
            aria-label="选择包含 LinkShell 配对二维码的图片"
            onClick={pickFile}
          >
            <ImageUp data-icon="inline-start" />
            {reading ? "识别中…" : "选择图片"}
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          tabIndex={-1}
          disabled={disabled || reading}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) scanImageFile(file);
          }}
        />
      </div>
      {camera && !disabled && (
        <div className="qr-camera-well">
          <video
            ref={video}
            className="mb-1.5 block aspect-[4/3] w-full rounded-lg bg-muted object-cover"
            muted
            playsInline
            aria-label="配对二维码扫描画面"
          />
          <p className="text-xs text-muted-foreground" role="status">
            {starting ? "正在打开摄像头…" : "将电脑上的配对二维码放入取景框"}
          </p>
        </div>
      )}
    </div>
  );
}
