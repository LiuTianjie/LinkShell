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
import { useId, useState } from "react";
import { useStore } from "zustand";
import { decodePairingLink } from "@linkshell/wire";
import { LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { engine } from "./engine";
import { accountClient } from "./account";
import { deployment, validateGateway, type Source } from "../config";
import { ErrorNotice, Modal, useJob } from "./common";
import { Icon } from "../icons";
import { Scan } from "./Scan";
import "./connection-polish.css";

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
  const blocked = job.busy || state.locked;
  const pairingLink = decodePairingLink(pairing);
  function updatePairing(value: string) {
    setPairing(value);
    const link = decodePairingLink(value);
    if (link) setAddress(link.gateway.replace(/^http/, "ws"));
    setInvalid({});
    job.clear();
  }
  const accountForm = (
    <form
      className="connection-form"
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
        {state.account ? (
          <>
            <Alert role="status">
              <ShieldCheck />
              <AlertTitle className="break-words">{state.account}</AlertTitle>
              <AlertDescription>
                在电脑运行 <code>linkshell login</code>
                ，使用同一账号即可发现电脑。电脑接入官方网关需要 Pro 订阅。
              </AlertDescription>
            </Alert>
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
              {job.busy && (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              )}
              刷新账号电脑
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={job.busy}
              onClick={() =>
                void job.run(async () => {
                  const result = await accountClient().auth.signOut({
                    scope: "local",
                  });
                  if (result.error) throw result.error;
                  engine.disconnect();
                })
              }
            >
              退出本浏览器账号
            </Button>
          </>
        ) : (
          <>
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
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              )}
              {job.busy ? "正在连接…" : "登录并连接"}
            </Button>
            <div className="connection-provider-actions">
              {(["github", "google"] as const).map((provider) => (
                <Button
                  variant="outline"
                  type="button"
                  key={provider}
                  disabled={blocked}
                  onClick={() =>
                    void job.run(async () => {
                      // The callback reload must boot the official account connection.
                      await engine.connectAccount();
                      const result = await accountClient().auth.signInWithOAuth(
                        {
                          provider,
                          options: {
                            redirectTo: location.origin + location.pathname,
                          },
                        },
                      );
                      if (result.error) throw result.error;
                    })
                  }
                >
                  {provider === "github" ? "GitHub 登录" : "Google 登录"}
                </Button>
              ))}
            </div>
            <p className="field-hint connection-registration">
              登录状态会自动续期。
              <a
                href="https://itool.tech/zh/register"
                target="_blank"
                rel="noreferrer"
              >
                注册 iTool 账号 ↗
              </a>
            </p>
          </>
        )}
      </FieldGroup>
    </form>
  );
  const pairingForm = (
    <form
      className="connection-form"
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
        <Alert role="note">
          <Icon name="computer" />
          <AlertTitle>先在电脑上生成配对码</AlertTitle>
          <AlertDescription>
            运行 <code>linkshell pair</code>
            ，扫描二维码，或输入电脑上显示的配对码。配对码在 10 分钟内有效。
          </AlertDescription>
        </Alert>
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
          <FieldDescription id={`${id}-pairing-hint`}>
            {pairingLink
              ? "已读取配对链接，网关地址已自动填写。"
              : "配对成功后，此浏览器会记住你的电脑。"}
          </FieldDescription>
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
          <FieldDescription id={`${id}-gateway-hint`}>
            {pairingLink
              ? "使用配对链接中指定的网关。更换网关时，请重新生成配对码。"
              : "填写电脑当前连接的网关地址。"}
          </FieldDescription>
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
        <p className="field-hint">
          清除网站数据后需要重新配对。自托管连接不会使用 iTool 登录凭证。
        </p>
      </FieldGroup>
    </form>
  );
  return (
    <Modal title="连接你的电脑" close={close}>
      <p className="muted modal-subtitle">
        电脑保持运行，网页即可继续你的会话。
      </p>
      {state.locked && (
        <Alert>
          <LockKeyhole />
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
          <TabsList className="w-full" aria-label="连接方式">
            <TabsTrigger value="official" disabled={job.busy}>
              <Icon name="globe" />
              官方账号
            </TabsTrigger>
            <TabsTrigger value="self-hosted" disabled={job.busy}>
              <Icon name="server" />
              配对电脑
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
