import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { useStore } from "zustand";
import {
  dateLocaleTag,
  membershipTierLabel,
  type ProMembership,
} from "@linkshell/client-core";
import { decodePairingLink } from "@linkshell/wire";
import {
  OFFICIAL_GATEWAY,
  cancelDesktopLoginRequest,
  engine,
  fetchDesktopProMembership,
  logoutDesktopAccount,
  pollDesktopLoginState,
  startDesktopLogin,
  validateGateway,
  type DesktopSignInMethod,
  type DesktopSignInRequest,
} from "../../core";
import { DesktopIcon } from "../../icons";
import {
  Badge,
  Button,
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  PairingCodeInput,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "../../primitives";
import { ReferralSummaryCard, SignInForm } from "./SignInForm";
import { useSystemI18n } from "./system-i18n";

const LINK_POLL_MS = 400;

/**
 * Zero-Jump Sign-In & Pairing Modal (`420px` top-anchored, `#7` §4.2, `#18`):
 * - Full-width `账号登录 | 扫码与配对` tabs with locked `min-block-size` so switching tabs
 *   or entering the 5m PKCE browser wait state NEVER shifts the modal's top edge.
 * - Single `<PairingCodeInput>` (never 6 separate boxes) + smart `linkshell://pair` paste detection
 *   + fixed-height QR screenshot drop / paste / pick / camera scanner (`qr-scanner`).
 */
export function SignInPairModal(props: {
  open: boolean;
  initialTab?: "account" | "pair";
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { open, initialTab = "account", onOpenChange } = props;
  const { locale, tCore, ts } = useSystemI18n();
  const engineState = useStore(engine.state);
  const titleId = useId();
  const descId = useId();

  const [tab, setTab] = useState<"account" | "pair">(initialTab);

  // Workspace Account Login Lifecycle
  const [pendingMethod, setPendingMethod] = useState<DesktopSignInMethod>();
  const [authLink, setAuthLink] = useState<string>();
  const [authError, setAuthError] = useState<string>();
  const [accountBusy, setAccountBusy] = useState(false);
  const loginRunningRef = useRef(false);
  const loginCancelledRef = useRef(false);

  // Pairing Form State
  const [codeDigits, setCodeDigits] = useState("");
  const [pastedLink, setPastedLink] = useState<string>();
  const [gatewayUrl, setGatewayUrl] = useState(
    engineState.gateway || OFFICIAL_GATEWAY,
  );
  const [pairError, setPairError] = useState<{
    code?: string;
    gateway?: string;
  }>({});
  const [pairingBusy, setPairingBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      if (loginRunningRef.current) {
        loginCancelledRef.current = true;
        void cancelDesktopLoginRequest().catch(() => undefined);
      }
      return;
    }
    setTab(initialTab);
    setAuthError(undefined);
    setPairError({});
    if (!pastedLink) {
      setGatewayUrl(engineState.gateway || OFFICIAL_GATEWAY);
    }
    // Reset initial tab whenever modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab]);

  const waitingOnBrowser =
    pendingMethod !== undefined && pendingMethod !== "password";

  const runWorkspaceLogin = async (request: DesktopSignInRequest) => {
    if (loginRunningRef.current) return;
    loginRunningRef.current = true;
    loginCancelledRef.current = false;
    setPendingMethod(request.method);
    setAuthLink(undefined);
    setAuthError(undefined);

    let pollingLink =
      request.method === "github" || request.method === "google";
    const pollLinkLoop = async () => {
      while (pollingLink) {
        await new Promise((resolve) => setTimeout(resolve, LINK_POLL_MS));
        if (!pollingLink) return;
        try {
          const state = await pollDesktopLoginState();
          if (pollingLink && state?.method === request.method && state.url) {
            setAuthLink(state.url);
            return;
          }
        } catch {
          // Next tick retries while PKCE loopback server starts.
        }
      }
    };
    if (pollingLink) void pollLinkLoop();

    try {
      await startDesktopLogin(request);
      await engine.connectAccount();
      onOpenChange(false);
    } catch (err) {
      if (!loginCancelledRef.current) {
        setAuthError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      pollingLink = false;
      loginRunningRef.current = false;
      setPendingMethod(undefined);
      setAuthLink(undefined);
    }
  };

  const handleCancelWorkspaceLogin = () => {
    loginCancelledRef.current = true;
    setPendingMethod(undefined);
    setAuthLink(undefined);
    void cancelDesktopLoginRequest().catch(() => undefined);
  };

  const applyPairingLinkText = (raw: string): boolean => {
    const trimmed = raw.trim();
    const decoded = decodePairingLink(trimmed);
    if (!decoded) return false;
    setPastedLink(trimmed);
    setCodeDigits(decoded.code ?? "");
    setGatewayUrl(decoded.gateway.replace(/^http/i, "ws"));
    setPairError({});
    return true;
  };

  const handlePairSubmit = async () => {
    if (pairingBusy || engineState.locked) return;
    const payload = pastedLink ?? codeDigits.trim();
    const decoded = pastedLink ? decodePairingLink(pastedLink) : undefined;

    if (!decoded && !/^\d{6}$/.test(payload)) {
      setPairError({ code: ts("pair.errInvalidCode") });
      return;
    }

    let normalizedGateway: string;
    try {
      normalizedGateway = validateGateway(
        (decoded?.gateway ?? gatewayUrl).replace(/^http/i, "ws"),
      );
    } catch (err) {
      setPairError({
        gateway: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    setPairError({});
    setPairingBusy(true);
    try {
      await engine.pair(normalizedGateway, payload);
      setCodeDigits("");
      setPastedLink(undefined);
      onOpenChange(false);
    } catch (err) {
      setPairError({
        code: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPairingBusy(false);
    }
  };

  const signedIn = Boolean(engineState.accountUserId || engineState.account);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (loginRunningRef.current) handleCancelWorkspaceLogin();
          onOpenChange(false);
        }
      }}
      size="sm"
      dismissible={!waitingOnBrowser}
      unmountWhenClosed
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="ls-signin-pair-dialog"
    >
      <DialogHeader
        onClose={() => {
          if (loginRunningRef.current) handleCancelWorkspaceLogin();
          onOpenChange(false);
        }}
        closeLabel={ts("modal.close")}
      >
        <DialogTitle id={titleId}>{ts("authModal.title")}</DialogTitle>
        <DialogDescription id={descId}>{ts("authModal.desc")}</DialogDescription>
      </DialogHeader>

      <Tabs
        value={tab}
        variant="segmented"
        onValueChange={(next) => setTab(next as "account" | "pair")}
      >
        <div className="ls-signin-pair-tabs-bar">
          <TabList label={ts("authModal.title")}>
            <Tab value="account" icon="user">
              {ts("authModal.tabAccount")}
            </Tab>
            <Tab value="pair" icon="pair-qr">
              {ts("authModal.tabPair")}
            </Tab>
          </TabList>
        </div>

        <TabPanel value="account">
          <div className="ls-signin-pair-panel-frame">
            {signedIn ? (
              <SignedInWorkspacePanel
                email={engineState.account}
                userId={engineState.accountUserId}
                locale={locale}
                busy={accountBusy}
                onSignOut={() => {
                  setAccountBusy(true);
                  void logoutDesktopAccount()
                    .then(() => engine.connectAccount())
                    .catch((err: unknown) =>
                      setAuthError(
                        err instanceof Error ? err.message : String(err),
                      ),
                    )
                    .finally(() => setAccountBusy(false));
                }}
                onRefreshComputers={() => {
                  setAccountBusy(true);
                  void engine
                    .connectAccount()
                    .then(() => onOpenChange(false))
                    .catch((err: unknown) =>
                      setAuthError(
                        err instanceof Error ? err.message : String(err),
                      ),
                    )
                    .finally(() => setAccountBusy(false));
                }}
                refreshLabel={ts("authModal.refreshComputers")}
                signOutLabel={tCore("common.signOut")}
                footNote={ts("authModal.signedInFoot")}
              />
            ) : (
              <SignInForm
                pending={pendingMethod}
                link={authLink}
                error={authError}
                disabled={accountBusy || engineState.locked}
                showZeroLoginNote
                onPassword={(email, password) =>
                  void runWorkspaceLogin({ method: "password", email, password })
                }
                onProvider={(provider) =>
                  void runWorkspaceLogin({ method: provider })
                }
                onBrowser={() => void runWorkspaceLogin({ method: "web" })}
                onCancel={handleCancelWorkspaceLogin}
                onEdit={() => setAuthError(undefined)}
              />
            )}
          </div>
        </TabPanel>

        <TabPanel value="pair">
          <div className="ls-signin-pair-panel-frame">
            <form
              className="ls-pair-form"
              noValidate
              aria-busy={pairingBusy}
              onSubmit={(event) => {
                event.preventDefault();
                void handlePairSubmit();
              }}
            >
              <QrDropScanner
                active={open && tab === "pair"}
                disabled={pairingBusy || engineState.locked}
                onFound={(link) => {
                  applyPairingLinkText(link);
                }}
              />

              {pastedLink ? (
                <div className="ls-system-banner" role="status">
                  <div className="ls-system-banner__copy">
                    <DesktopIcon name="check-circle" size="sm" />
                    <span>{ts("pair.linkDetected")}</span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPastedLink(undefined);
                      setCodeDigits("");
                    }}
                  >
                    {ts("pair.clearLink")}
                  </Button>
                </div>
              ) : (
                <div className="ls-field">
                  <PairingCodeInput
                    label={ts("pair.codeLabel")}
                    value={codeDigits}
                    disabled={pairingBusy || engineState.locked}
                    aria-invalid={Boolean(pairError.code) || undefined}
                    onPaste={(event) => {
                      const text = event.clipboardData?.getData("text") ?? "";
                      if (text.trim().startsWith("linkshell:")) {
                        event.preventDefault();
                        if (!applyPairingLinkText(text)) {
                          setPairError({ code: ts("pair.errInvalidCode") });
                        }
                      }
                    }}
                    onValueChange={(digits) => {
                      setCodeDigits(digits);
                      setPairError({});
                    }}
                  />
                  {pairError.code ? (
                    <p role="alert" className="ls-field__error">
                      {pairError.code}
                    </p>
                  ) : (
                    <p className="ls-field__desc">{ts("pair.codeHint")}</p>
                  )}
                </div>
              )}

              <Field
                label={ts("pair.gatewayLabel")}
                description={ts("pair.gatewayHint")}
                error={pairError.gateway}
              >
                <Input
                  type="url"
                  value={gatewayUrl}
                  readOnly={Boolean(pastedLink)}
                  disabled={pairingBusy || engineState.locked}
                  autoComplete="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={OFFICIAL_GATEWAY}
                  aria-invalid={Boolean(pairError.gateway) || undefined}
                  onChange={(event) => {
                    setGatewayUrl(event.target.value);
                    setPairError({});
                  }}
                />
              </Field>

              <Button
                type="submit"
                variant="primary"
                className="ls-system-full-btn"
                loading={pairingBusy}
                disabled={pairingBusy || engineState.locked}
              >
                {pairingBusy ? ts("pair.submittingBtn") : ts("pair.submitBtn")}
              </Button>
            </form>

            <p className="ls-signin-local-note">{ts("pair.e2eeFoot")}</p>
          </div>
        </TabPanel>
      </Tabs>
    </Dialog>
  );
}

function SignedInWorkspacePanel({
  email,
  userId,
  locale,
  busy,
  onSignOut,
  onRefreshComputers,
  refreshLabel,
  signOutLabel,
  footNote,
}: {
  email?: string;
  userId?: string;
  locale: "zh" | "en" | "ja";
  busy: boolean;
  onSignOut: () => void;
  onRefreshComputers: () => void;
  refreshLabel: string;
  signOutLabel: string;
  footNote: string;
}) {
  const [membership, setMembership] = useState<ProMembership>();

  useEffect(() => {
    if (!userId) {
      setMembership(undefined);
      return undefined;
    }
    let alive = true;
    void fetchDesktopProMembership(userId)
      .then((res) => {
        if (alive) setMembership(res);
      })
      .catch(() => {
        if (alive) setMembership(undefined);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  return (
    <div className="ls-signin-form">
      <div className="ls-system-card">
        <div className="ls-system-row">
          <div className="ls-system-row__copy">
            <span className="ls-system-row__title">
              <DesktopIcon name="user" size="sm" />
              {email ?? userId}
            </span>
            {membership?.plan === "pro" ? (
              <span className="ls-system-row__detail">
                {membershipTierLabel(membership.tier, {
                  isTrial: membership.isTrial,
                  daysRemaining: membership.daysRemaining,
                  locale,
                })}
                {membership.expiresAt
                  ? ` · ${new Date(membership.expiresAt).toLocaleDateString(
                      dateLocaleTag(locale),
                    )}`
                  : ""}
              </span>
            ) : null}
          </div>
          <div className="ls-system-row__controls">
            {membership?.plan === "pro" ? (
              <Badge tone="ok" dot="ok">
                Pro
              </Badge>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onSignOut}
            >
              {signOutLabel}
            </Button>
          </div>
        </div>
      </div>

      {userId ? <ReferralSummaryCard userId={userId} disabled={busy} /> : null}

      <Button
        variant="primary"
        className="ls-system-full-btn"
        loading={busy}
        disabled={busy}
        onClick={onRefreshComputers}
      >
        {refreshLabel}
      </Button>

      <p className="ls-signin-local-note">{footNote}</p>
    </div>
  );
}

function QrDropScanner({
  active,
  disabled,
  onFound,
}: {
  active: boolean;
  disabled: boolean;
  onFound: (link: string) => void;
}) {
  const { ts } = useSystemI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const operationRef = useRef({ seq: 0 });
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;

  const [hasCamera, setHasCamera] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>();

  useEffect(() => {
    const tracker = operationRef.current;
    return () => {
      tracker.seq++;
    };
  }, []);

  useEffect(() => {
    if (!active || typeof window === "undefined") return undefined;
    const coarse =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    if (!coarse || !navigator.mediaDevices?.enumerateDevices) return undefined;
    let alive = true;
    void navigator.mediaDevices.enumerateDevices().then(
      (list) => {
        if (alive) {
          setHasCamera(list.some((item) => item.kind === "videoinput"));
        }
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [active]);

  const acceptQrData = (raw: string) => {
    if (disabled) return;
    if (!decodePairingLink(raw)) {
      setStatus("error");
      setErrorMessage(ts("pair.errNotLinkshellQr"));
      return;
    }
    setCameraOpen(false);
    setStatus("ok");
    setErrorMessage(undefined);
    onFoundRef.current(raw.trim());
  };

  const scanFile = (file: File) => {
    if (disabled || reading) return;
    const op = ++operationRef.current.seq;
    setCameraOpen(false);
    setReading(true);
    setStatus("idle");
    setErrorMessage(undefined);
    void import("qr-scanner")
      .then((mod) =>
        mod.default.scanImage(file, { returnDetailedScanResult: true }),
      )
      .then(
        (result) => {
          if (op === operationRef.current.seq) acceptQrData(result.data);
        },
        () => {
          if (op === operationRef.current.seq) {
            setStatus("error");
            setErrorMessage(ts("pair.errUnreadableQr"));
          }
        },
      )
      .finally(() => {
        if (op === operationRef.current.seq) setReading(false);
      });
  };

  const scanFileRef = useRef(scanFile);
  scanFileRef.current = scanFile;

  useEffect(() => {
    if (!active || disabled) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            scanFileRef.current(file);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [active, disabled]);

  useEffect(() => {
    if (!cameraOpen || !active || disabled || !videoRef.current) {
      return undefined;
    }
    let disposed = false;
    let scanner: import("qr-scanner").default | undefined;
    void import("qr-scanner")
      .then(async ({ default: QrScanner }) => {
        if (disposed || !videoRef.current) return;
        scanner = new QrScanner(
          videoRef.current,
          (res) => {
            if (!disposed) acceptQrData(res.data);
          },
          {
            preferredCamera: "environment",
            returnDetailedScanResult: true,
            highlightScanRegion: true,
          },
        );
        await scanner.start();
        if (!disposed) setCameraStarting(false);
      })
      .catch(() => {
        if (!disposed) {
          setCameraOpen(false);
          setCameraStarting(false);
          setStatus("error");
          setErrorMessage(ts("pair.errCamera"));
        }
      });
    return () => {
      disposed = true;
      scanner?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOpen, active, disabled]);

  const openFilePicker = () => {
    if (disabled || reading || !fileInputRef.current) return;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  };

  return (
    <>
      <div
        className="ls-qr-dropwell"
        data-dragging={dragging ? "true" : undefined}
        data-tone={
          status === "ok" ? "ok" : status === "error" ? "danger" : undefined
        }
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
          if (
            event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            return;
          }
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled || reading) return;
          const file = Array.from(event.dataTransfer.files).find((f) =>
            f.type.startsWith("image/"),
          );
          if (file) scanFile(file);
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          openFilePicker();
        }}
      >
        <div className="ls-qr-dropwell__main">
          <DesktopIcon
            name={
              reading
                ? "spinner"
                : status === "ok"
                  ? "check-circle"
                  : status === "error"
                    ? "alert-circle"
                    : "pair-qr"
            }
            size="md"
          />
          <div
            className="ls-qr-dropwell__copy"
            role={status === "error" ? "alert" : "status"}
          >
            <strong>
              {reading
                ? ts("pair.scanTitleReading")
                : status === "ok"
                  ? ts("pair.scanTitleOk")
                  : status === "error"
                    ? ts("pair.scanTitleErr")
                    : ts("pair.scanTitleIdle")}
            </strong>
            <span>
              {reading
                ? ts("pair.scanDescReading")
                : status === "ok"
                  ? ts("pair.scanDescOk")
                  : status === "error"
                    ? errorMessage
                    : ts("pair.scanDescIdle")}
            </span>
          </div>
        </div>

        <div className="ls-system-row__controls">
          {hasCamera ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled || reading}
              onClick={() => {
                setCameraStarting(!cameraOpen);
                setCameraOpen((prev) => !prev);
              }}
            >
              {cameraOpen ? ts("pair.closeCamera") : ts("pair.openCamera")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            leadingIcon="image"
            disabled={disabled || reading}
            onClick={openFilePicker}
          >
            {ts("pair.pickImage")}
          </Button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          tabIndex={-1}
          disabled={disabled || reading}
          className="ls-sr-only-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) scanFile(file);
          }}
        />
      </div>

      {cameraOpen && !disabled ? (
        <div className="ls-qr-camera-box">
          <video ref={videoRef} muted playsInline />
          <span className="ls-system-note" role="status">
            {cameraStarting ? ts("pair.cameraStarting") : ts("pair.cameraReady")}
          </span>
        </div>
      ) : null}
    </>
  );
}
