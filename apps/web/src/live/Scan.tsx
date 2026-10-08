import { useEffect, useRef, useState } from "react";
import { decodePairingLink } from "@linkshell/wire";
import { ErrorNotice } from "./common";

export function Scan({ found }: { found: (link: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState<string>();
  const callback = useRef(found);
  callback.current = found;
  function accept(text: string) {
    if (!decodePairingLink(text)) {
      setError("这不是有效的 LinkShell 配对二维码");
      return;
    }
    callback.current(text);
    setCamera(false);
    setError(undefined);
  }
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  useEffect(() => {
    if (!camera || !video.current) return;
    let closed = false;
    let scanner: import("qr-scanner").default | undefined;
    void import("qr-scanner")
      .then(async ({ default: QrScanner }) => {
        if (closed || !video.current) return;
        scanner = new QrScanner(
          video.current,
          (result) => acceptRef.current(result.data),
          {
            preferredCamera: "environment",
            returnDetailedScanResult: true,
            highlightScanRegion: true,
          },
        );
        await scanner.start();
      })
      .catch((error) => {
        if (!closed) {
          setError(
            error instanceof Error
              ? error.message
              : "无法打开摄像头，请使用图片或配对码",
          );
          setCamera(false);
        }
      });
    return () => {
      closed = true;
      scanner?.destroy();
    };
  }, [camera]);
  return (
    <div className="qr-scan">
      <div className="permission-buttons">
        <button
          className="button secondary"
          type="button"
          onClick={() => setCamera(!camera)}
        >
          {camera ? "关闭摄像头" : "扫描二维码"}
        </button>
        <label className="button secondary">
          从图片识别
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file)
                void import("qr-scanner")
                  .then((module) =>
                    module.default.scanImage(file, {
                      returnDetailedScanResult: true,
                    }),
                  )
                  .then(
                    (result) => accept(result.data),
                    () =>
                      setError("没有识别到二维码，请换一张图片或输入配对码"),
                  );
            }}
          />
        </label>
      </div>
      {camera && <video ref={video} className="qr-video" muted playsInline />}
      <ErrorNotice error={error} />
    </div>
  );
}
