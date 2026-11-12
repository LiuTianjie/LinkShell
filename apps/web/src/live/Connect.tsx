import { ArrowUpRight, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { decodePairingLink } from "@linkshell/wire";
import appMark from "../../../client/assets/mark.png";
import { engine } from "./engine";
import { accountClient } from "./account";
import { signInWithAccountOAuth } from "./account-oauth";
import { deployment, validateGateway, type Source } from "../config";
import { ErrorNotice, Modal, useJob } from "./common";
import { Scan } from "./Scan";
import { AccountSummary, ReferralCard } from "./AccountMembership";
import { desktopLogout, isDesktop, openDesktopManagement } from "./desktop";
import { SignIn } from "./SignIn";
import { useDesktopSignIn } from "./desktop-sign-in";

export function Connect({ close }: { close: () => void }) {
  const state = useStore(engine.state);
  const id = useId();
  const [source, setSource] = useState<Source>(state.source);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [address, setAddress] = useState(
    source === "self-hosted" ? state.gateway : "",
  );
  const [pairing, setPairing] = useState("");
  const [invalid, setInvalid] = useState<{
    pairing?: string;
    gateway?: string;
  }>({});
  const job = useJob();
  const oauth = useRef<AbortController | null>(null);
  const [oauthStage, setOAuthStage] = useState<"waiting" | "exchanging">();
  useEffect(() => () => oauth.current?.abort(), []);
  const blocked = job.busy || state.locked;
  const signIn = useDesktopSignIn(async () => {
    await engine.connectAccount();
    close();
  });
  const pairingLink = decodePairingLink(pairing);

  function updatePairing(value: string) {
    setPairing(value);
    const link = decodePairingLink(value);
    if (link) setAddress(link.gateway.replace(/^http/, "ws"));
    setInvalid({});
    job.clear();
  }

  const accountForm = isDesktop ? (
    state.accountUserId ? (
      <div className="connect-signed-in">
        <div className="connect-account-box">
          <AccountSummary
            email={state.account}
            userId={state.accountUserId}
            disabled={job.busy}
            onSignOut={() => void job.run(desktopLogout)}
          />
        </div>
        <ReferralCard userId={state.accountUserId} disabled={job.busy} reserveSpace />
        <div className="connect-panel-actions">
          <Button
            className="connect-submit w-full"
            disabled={blocked}
            onClick={() =>
              void job.run(async () => {
                await engine.connectAccount();
                close();
              })
            }
          >
            {job.busy && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
            刷新电脑列表
          </Button>
          <p className="connect-panel-foot">
            在另一台电脑运行 <code>linkshell login</code> 登录同一账号即可自动显示
          </p>
        </div>
      </div>
    ) : (
      <SignIn
        {...signIn}
        disabled={blocked}
      />
    )
  ) : state.account ? (
    <div className="connect-signed-in min-w-0">
      <div className="connect-account-box">
        <AccountSummary
          email={state.account}
          userId={state.accountUserId}
          disabled={job.busy}
          onSignOut={() =>
            void job.run(async () => {
              const result = await accountClient().auth.signOut({ scope: "local" });
              if (result.error) throw result.error;
              engine.disconnect();
            })
          }
        />
      </div>
      {state.accountUserId && (
        <ReferralCard userId={state.accountUserId} disabled={job.busy} reserveSpace />
      )}
      <div className="connect-panel-actions">
        <Button
          type="button"
          className="connect-submit w-full"
          disabled={blocked}
          onClick={() =>
            void job.run(async () => {
              await engine.connectAccount();
              close();
            })
          }
        >
          {job.busy && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
          刷新电脑列表
        </Button>
        <p className="connect-panel-foot">
          在电脑上运行 <code>linkshell login</code> 登录同一账号即可自动发现
        </p>
      </div>
    </div>
  ) : (
    <form
      className="connect-web-signin min-w-0 [&_[data-slot=alert-description]]:break-words [&_[data-slot=alert-title]]:break-words [&_[data-slot=field]]:min-w-0"
      aria-busy={job.busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        void job.run(async () => {
          const result = await accountClient().auth.signInWithPassword({
            email: email.trim(),
            password,
          });
          if (result.error) throw result.error;
          await engine.connectAccount();
          close();
        });
      }}
    >
      <div className="grid grid-cols-1 gap-2 min-[381px]:grid-cols-2">
        {(["github", "google"] as const).map((provider) => (
          <Button
            variant="outline"
            type="button"
            className="connect-provider-btn"
            key={provider}
            disabled={blocked}
            onClick={() =>
              void job.run(async () => {
                const controller = new AbortController();
                oauth.current = controller;
                setOAuthStage("waiting");
                try {
                  await signInWithAccountOAuth(accountClient().auth, provider, {
                    signal: controller.signal,
                    onExchanging: () => setOAuthStage("exchanging"),
                  });
                  if (controller.signal.aborted) return;
                  await engine.connectAccount();
                  if (controller.signal.aborted) return;
                  close();
                } finally {
                  oauth.current = null;
                  setOAuthStage(undefined);
                }
              })
            }
          >
            {provider === "github" ? "使用 GitHub 继续" : "使用 Google 继续"}
          </Button>
        ))}
      </div>
      <div className="connect-or-divider" role="separator" aria-label="或使用邮箱">
        <span>或使用邮箱</span>
      </div>
      <FieldGroup className="gap-3">
        <Field data-disabled={blocked}>
          <FieldLabel htmlFor={`${id}-email`}>邮箱</FieldLabel>
          <Input
            id={`${id}-email`}
            type="email"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            placeholder="你的 iTool 账号邮箱"
            value={email}
            disabled={blocked}
            onChange={(event) => {
              setEmail(event.target.value);
              job.clear();
            }}
            required
          />
        </Field>
        <Field data-disabled={blocked}>
          <FieldLabel htmlFor={`${id}-password`}>密码</FieldLabel>
          <div className="connect-password-wrap">
            <Input
              id={`${id}-password`}
              type={showPassword ? "text" : "password"}
              name="password"
              autoComplete="current-password"
              enterKeyHint="done"
              placeholder="输入登录密码"
              className="pr-9"
              value={password}
              disabled={blocked}
              onChange={(event) => {
                setPassword(event.target.value);
                job.clear();
              }}
              required
            />
            <button
              type="button"
              className="connect-password-toggle"
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              aria-pressed={showPassword}
              disabled={blocked}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </button>
          </div>
        </Field>
      </FieldGroup>
      {oauthStage && (
        <div className="flex items-center justify-between gap-3" role="status">
          <p className="field-hint">{oauthStage === "waiting" ? "请在登录窗口中完成授权。" : "正在完成登录…"}</p>
          <Button type="button" variant="ghost" size="sm" disabled={oauthStage === "exchanging"} onClick={() => oauth.current?.abort()}>
            取消登录
          </Button>
        </div>
      )}
      <div className="connect-panel-actions">
        <Button className="connect-submit w-full" disabled={blocked}>
          {job.busy && (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          )}
          {job.busy ? "正在连接…" : "登录并连接"}
        </Button>
        <p className="connect-panel-foot">
          还没有账号？
          <a
            href="https://itool.tech/zh/register"
            target="_blank"
            rel="noreferrer"
          >
            注册 iTool 账号 <ArrowUpRight className="external-link-icon" aria-hidden />
          </a>
        </p>
      </div>
    </form>
  );

  const pairingForm = (
    <form
      className="connect-pairing-form min-w-0 [&_[data-slot=alert-description]]:break-words [&_[data-slot=alert-title]]:break-words [&_[data-slot=field]]:min-w-0"
      aria-busy={job.busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        const value = pairing.trim();
        if (!pairingLink && !/^\d{6}$/.test(value)) {
          setInvalid({
            pairing: value.startsWith("linkshell:")
              ? "配对链接不完整，请重新复制。"
              : "请输入 6 位数字配对码，或完整的配对链接。",
          });
          document.getElementById(`${id}-pairing`)?.focus();
          return;
        }
        try {
          validateGateway(
            (pairingLink?.gateway ?? address).replace(/^http/, "ws"),
          );
        } catch (error) {
          setInvalid({
            gateway: error instanceof Error ? error.message : "请检查网关地址",
          });
          document.getElementById(`${id}-gateway`)?.focus();
          return;
        }
        setInvalid({});
        void job.run(async () => {
          await engine.pair(address, value);
          close();
        });
      }}
    >
      <Scan found={updatePairing} disabled={blocked} />
      <FieldGroup className="connect-pairing-fields">
        <Field data-invalid={!!invalid.pairing} data-disabled={blocked}>
          <div className="connect-label-row">
            <FieldLabel htmlFor={`${id}-pairing`}>配对码或配对链接</FieldLabel>
            <span id={`${id}-pairing-hint`} className="connect-field-note">
              <code>linkshell pair</code> · 10 分钟有效
            </span>
          </div>
          <Input
            id={`${id}-pairing`}
            name="pairing"
            value={pairing}
            disabled={blocked}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            aria-invalid={!!invalid.pairing}
            aria-describedby={`${id}-pairing-hint${invalid.pairing ? ` ${id}-pairing-error` : ""}`}
            onChange={(event) => updatePairing(event.target.value)}
            placeholder="6 位配对码，或 linkshell://pair 链接"
            required
          />
          {invalid.pairing && (
            <FieldError id={`${id}-pairing-error`}>
              {invalid.pairing}
            </FieldError>
          )}
        </Field>
        <Field
          data-invalid={!!invalid.gateway}
          data-disabled={blocked}
        >
          <div className="connect-label-row">
            <FieldLabel htmlFor={`${id}-gateway`}>网关地址</FieldLabel>
            <span
              id={`${id}-gateway-hint`}
              className="connect-field-note"
              data-ok={pairingLink ? "" : undefined}
            >
              {pairingLink ? "已从配对链接读取" : "电脑当前连接的网关"}
            </span>
          </div>
          <Input
            id={`${id}-gateway`}
            name="gateway"
            type="url"
            placeholder="wss://gateway.example.com"
            value={address}
            autoComplete="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            disabled={blocked}
            readOnly={!!pairingLink}
            data-readonly={pairingLink ? "" : undefined}
            aria-invalid={!!invalid.gateway}
            aria-describedby={`${id}-gateway-hint${invalid.gateway ? ` ${id}-gateway-error` : ""}`}
            onChange={(event) => {
              setAddress(event.target.value);
              setInvalid({});
              job.clear();
            }}
            required={!pairingLink}
          />
          {invalid.gateway && (
            <FieldError id={`${id}-gateway-error`}>
              {invalid.gateway}
            </FieldError>
          )}
        </Field>
      </FieldGroup>
      <div className="connect-panel-actions">
        <Button className="connect-submit w-full" disabled={blocked}>
          {job.busy && (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          )}
          {job.busy ? "正在配对…" : "配对并连接"}
        </Button>
        <p className="connect-panel-foot">
          端到端加密通道，网关仅转发密文，不接触会话与屏幕内容
        </p>
      </div>
    </form>
  );

  return (
    <Modal
      title="连接你的电脑"
      description={
        deployment === "official"
          ? "登录同一账号自动发现电脑，或使用配对码连接"
          : "在电脑运行 linkshell pair，扫码或输入配对码连接"
      }
      icon={<img src={appMark} alt="" aria-hidden className="connect-dialog-mark" />}
      close={close}
      className="connect-dialog"
    >
      {/* The local computer needs no account; say something only when it is unreachable. */}
      {isDesktop && state.localError && (
        <p className="connect-local" data-error>
          <span>{state.localError}</span>
          <button type="button" className="connect-local-link" onClick={openDesktopManagement}>本机服务</button>
          <button type="button" className="connect-local-link" disabled={job.busy} onClick={() => void job.run(() => engine.refreshLocal())}>重新检测</button>
        </p>
      )}
      {state.locked && (
        <Alert>
          <AlertTitle>连接正在另一个标签页中使用</AlertTitle>
          <AlertDescription>
            <p>切换到此页后，另一个标签页会断开连接。</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={job.busy}
              onClick={() => void job.run(() => engine.claim())}
            >
              在此页继续
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {deployment === "official" ? (
        <Tabs
          value={source}
          onValueChange={(value) => {
            setSource(value as Source);
            job.clear();
            setInvalid({});
          }}
        >
          <TabsList className="connect-tabs w-full" aria-label="连接方式">
            <TabsTrigger value="official" disabled={job.busy}>
              账号登录
            </TabsTrigger>
            <TabsTrigger value="self-hosted" disabled={job.busy}>
              扫码与配对
            </TabsTrigger>
          </TabsList>
          <TabsContent value="official" className="connect-panel">
            {accountForm}
          </TabsContent>
          <TabsContent value="self-hosted" className="connect-panel">
            {pairingForm}
          </TabsContent>
        </Tabs>
      ) : (
        <div className="connect-panel">{pairingForm}</div>
      )}
      <ErrorNotice error={job.error} />
    </Modal>
  );
}
