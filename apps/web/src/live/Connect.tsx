import { ArrowUpRight } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { decodePairingLink } from "@linkshell/wire";
import { LoaderCircle } from "lucide-react";
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
      <div className="flex flex-col gap-5">
        <AccountSummary
          email={state.account}
          userId={state.accountUserId}
          disabled={job.busy}
          onSignOut={() => void job.run(desktopLogout)}
        />
        <ReferralCard userId={state.accountUserId} disabled={job.busy} />
        <Button disabled={blocked} onClick={() => void job.run(async () => {
          await engine.connectAccount();
          close();
        })}>
          {job.busy && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
          刷新电脑列表
        </Button>
      </div>
    ) : (
      <SignIn
        {...signIn}
        disabled={blocked}
      />
    )
  ) : state.account ? (
    <div className="flex min-w-0 flex-col gap-5">
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
      {state.accountUserId && <ReferralCard userId={state.accountUserId} disabled={job.busy} />}
      <p className="field-hint">
        在电脑上运行 <code>linkshell login</code> 登录同一账号，电脑就会出现在这里。
      </p>
      <Button
        type="button"
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
    </div>
  ) : (
    <form
      className="min-w-0 [&_[data-slot=alert-description]]:break-words [&_[data-slot=alert-title]]:break-words [&_[data-slot=field]]:min-w-0"
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
      <FieldGroup>
        <Field data-disabled={blocked}>
          <FieldLabel htmlFor={`${id}-email`}>邮箱</FieldLabel>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
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
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={blocked}
            onChange={(event) => {
              setPassword(event.target.value);
              job.clear();
            }}
            required
          />
        </Field>
        <Button disabled={blocked}>
          {job.busy && (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          )}
          {job.busy ? "正在连接…" : "登录并连接"}
        </Button>
        <div className="grid grid-cols-1 gap-2 min-[381px]:grid-cols-2">
          {(["github", "google"] as const).map((provider) => (
            <Button
              variant="outline"
              type="button"
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
              {provider === "github" ? "GitHub 登录" : "Google 登录"}
            </Button>
          ))}
        </div>
        {oauthStage && (
          <div className="flex items-center justify-between gap-3" role="status">
            <p className="field-hint">{oauthStage === "waiting" ? "请在登录窗口中完成授权。" : "正在完成登录…"}</p>
            <Button type="button" variant="ghost" size="sm" disabled={oauthStage === "exchanging"} onClick={() => oauth.current?.abort()}>
              取消登录
            </Button>
          </div>
        )}
        <p className="field-hint text-center">
          没有账号？
          <a
            href="https://itool.tech/zh/register"
            target="_blank"
            rel="noreferrer"
          >
            注册 iTool 账号 <ArrowUpRight className="external-link-icon" aria-hidden />
          </a>
        </p>
      </FieldGroup>
    </form>
  );
  const pairingForm = (
    <form
      className="min-w-0 [&_[data-slot=alert-description]]:break-words [&_[data-slot=alert-title]]:break-words [&_[data-slot=field]]:min-w-0"
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
      <FieldGroup>
        <p className="field-hint">
          在电脑上运行 <code>linkshell pair</code>，扫码或输入显示的配对码（10 分钟内有效）。
        </p>
        <Scan found={updatePairing} disabled={blocked} />
        <Field data-invalid={!!invalid.pairing} data-disabled={blocked}>
          <FieldLabel htmlFor={`${id}-pairing`}>配对码或配对链接</FieldLabel>
          <Input
            id={`${id}-pairing`}
            value={pairing}
            disabled={blocked}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={!!invalid.pairing}
            aria-describedby={`${id}-pairing-hint${invalid.pairing ? ` ${id}-pairing-error` : ""}`}
            onChange={(event) => updatePairing(event.target.value)}
            placeholder="6 位配对码，或 linkshell://pair 链接"
            required
          />
          {pairingLink && (
            <FieldDescription id={`${id}-pairing-hint`}>已从配对链接读取网关地址。</FieldDescription>
          )}
          {invalid.pairing && (
            <FieldError id={`${id}-pairing-error`}>
              {invalid.pairing}
            </FieldError>
          )}
        </Field>
        <Field
          data-invalid={!!invalid.gateway}
          data-disabled={blocked || !!pairingLink}
        >
          <FieldLabel htmlFor={`${id}-gateway`}>网关地址</FieldLabel>
          <Input
            id={`${id}-gateway`}
            type="url"
            placeholder="wss://gateway.example.com"
            value={address}
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            disabled={blocked}
            readOnly={!!pairingLink}
            aria-invalid={!!invalid.gateway}
            aria-describedby={`${id}-gateway-hint${invalid.gateway ? ` ${id}-gateway-error` : ""}`}
            onChange={(event) => {
              setAddress(event.target.value);
              setInvalid({});
              job.clear();
            }}
            required={!pairingLink}
          />
          {!pairingLink && (
            <FieldDescription id={`${id}-gateway-hint`}>电脑当前连接的网关。</FieldDescription>
          )}
          {invalid.gateway && (
            <FieldError id={`${id}-gateway-error`}>
              {invalid.gateway}
            </FieldError>
          )}
        </Field>
        <Button disabled={blocked}>
          {job.busy && (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          )}
          {job.busy ? "正在配对…" : "配对并连接"}
        </Button>
      </FieldGroup>
    </form>
  );
  return (
    <Modal title="连接你的电脑" close={close} className="connect-dialog">
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
          <TabsList variant="line" className="connect-tabs w-full" aria-label="连接方式">
            <TabsTrigger value="official" disabled={job.busy}>
              账号登录
            </TabsTrigger>
            <TabsTrigger value="self-hosted" disabled={job.busy}>
              配对码
            </TabsTrigger>
          </TabsList>
          <TabsContent value="official" className="pt-4">
            {accountForm}
          </TabsContent>
          <TabsContent value="self-hosted" className="pt-4">
            {pairingForm}
          </TabsContent>
        </Tabs>
      ) : (
        pairingForm
      )}
      <ErrorNotice error={job.error} />
    </Modal>
  );
}
