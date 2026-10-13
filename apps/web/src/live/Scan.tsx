import { FilePicker } from "@/components/FilePicker";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { decodePairingLink } from "@linkshell/wire";
import { Camera, CheckCircle2, LoaderCircle, X } from "lucide-react";
import { ErrorNotice } from "./common";

export function Scan({
  found,
  disabled = false,
}: {
  found: (link: string) => void;
  disabled?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState(false);
  const [starting, setStarting] = useState(false);
  const [reading, setReading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string>();
  const callback = useRef(found);
  const disabledRef = useRef(disabled);
  const operation = useRef(0);
  const accepted = useRef(false);
  callback.current = found;
  disabledRef.current = disabled;
  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );
  function accept(text: string) {
    if (accepted.current || disabledRef.current) return;
    if (!decodePairingLink(text)) {
      setError(
        "这不是有效的 LinkShell 配对二维码，请扫描电脑上 linkshell pair 生成的二维码。",
      );
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
          setError(
            "无法打开摄像头。请检查浏览器的摄像头权限，或选择二维码图片、手动输入配对码。",
          );
          setCamera(false);
          setStarting(false);
        }
      });
    return () => {
      closed = true;
      scanner?.destroy();
    };
  }, [camera, disabled]);
  return (
    <div className="qr-scan connection-scanner">
      <div className="connection-scan-actions">
        <Button
          variant="outline"
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
          {camera ? (
            <X data-icon="inline-start" />
          ) : (
            <Camera data-icon="inline-start" />
          )}
          {camera ? "关闭摄像头" : "扫描二维码"}
        </Button>
        <FilePicker
          accept="image/*"
          disabled={disabled || reading}
          aria-label="选择包含 LinkShell 配对二维码的图片"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
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
                  if (current === operation.current)
                    acceptRef.current(result.data);
                },
                () => {
                  if (current === operation.current)
                    setError(
                      "没有识别到二维码，请选择清晰的二维码图片，或手动输入配对码。",
                    );
                },
              )
              .finally(() => {
                if (current === operation.current) setReading(false);
              });
          }}
        >
          {reading ? "正在识别…" : "从图片识别"}
        </FilePicker>
      </div>
      {camera && !disabled && (
        <div className="connection-camera">
          <video
            ref={video}
            className="qr-video"
            muted
            playsInline
            aria-label="配对二维码扫描画面"
          />
          <p className="field-hint" role="status">
            {starting ? "正在打开摄像头…" : "将电脑上的配对二维码放入取景框"}
          </p>
        </div>
      )}
      {reading && (
        <p className="connection-scan-status" role="status">
          <LoaderCircle className="animate-spin" />
          正在读取二维码图片…
        </p>
      )}
      {success && (
        <p className="connection-scan-status" role="status">
          <CheckCircle2 />
          已读取二维码，请确认后连接。
        </p>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
