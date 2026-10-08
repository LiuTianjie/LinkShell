import { useState } from "react";
import { useStore } from "zustand";
import { engine } from "./engine";
import { accountClient } from "./account";
import { deployment, type Source } from "../config";
import { ErrorNotice, Modal, useJob } from "./common";
import { Icon } from "../icons";
import { Scan } from "./Scan";

export function Connect({ close }: { close: () => void }) {
  const state = useStore(engine.state);
  const [source, setSource] = useState<Source>(state.source);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [address, setAddress] = useState(
    source === "self-hosted" ? state.gateway : "",
  );
  const [pairing, setPairing] = useState("");

  const job = useJob();
  return (
    <Modal title="连接你的电脑" close={close}>
      <p className="muted modal-subtitle">
        电脑保持运行，网页即可继续你的会话。
      </p>
      {deployment === "official" && (
        <div className="source-options">
          <button
            className={`source-option ${source === "official" ? "selected" : ""}`}
            aria-pressed={source === "official"}
            onClick={() => setSource("official")}
          >
            <Icon name="globe" />
            <strong>官方账号</strong>
            <span>同一 iTool 账号发现电脑</span>
          </button>
          <button
            className={`source-option ${source === "self-hosted" ? "selected" : ""}`}
            aria-pressed={source === "self-hosted"}
            onClick={() => setSource("self-hosted")}
          >
            <Icon name="server" />
            <strong>配对电脑</strong>
            <span>官方或自托管网关的配对码</span>
          </button>
        </div>
      )}
      {source === "official" ? (
        <form
          className="new-form"
          onSubmit={(event) => {
            event.preventDefault();
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
          {state.account ? (
            <div className="private-note">
              <div>
                <strong>{state.account}</strong>
                <p>
                  电脑端运行 linkshell login，使用同一账号。电脑接入官方网关需要
                  Pro 订阅。
                </p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    void job.run(async () => {
                      await engine.connectAccount();
                      close();
                    })
                  }
                >
                  刷新账号电脑
                </button>
              </div>
            </div>
          ) : (
            <>
              <label htmlFor="email">邮箱</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              <label htmlFor="password">密码</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button className="button primary full" disabled={job.busy}>
                登录
              </button>
              <div className="form-columns">
                {(["github", "google"] as const).map((provider) => (
                  <button
                    type="button"
                    className="button secondary"
                    key={provider}
                    disabled={job.busy}
                    onClick={() =>
                      void job.run(async () => {
                        const result =
                          await accountClient().auth.signInWithOAuth({
                            provider,
                            options: {
                              redirectTo: location.origin + location.pathname,
                            },
                          });
                        if (result.error) throw result.error;
                      })
                    }
                  >
                    {provider === "github" ? "GitHub 登录" : "Google 登录"}
                  </button>
                ))}
              </div>
              <p className="field-hint">
                登录状态自动续期。
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
          {state.account && (
            <button
              type="button"
              className="button secondary full"
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
            </button>
          )}
        </form>
      ) : (
        <form
          className="pairing-form"
          onSubmit={(event) => {
            event.preventDefault();
            void job.run(async () => {
              await engine.pair(address, pairing);
              close();
            });
          }}
        >
          <Scan found={setPairing} />
          <label htmlFor="gateway">网关地址</label>
          <input
            id="gateway"
            placeholder="wss://gateway.example.com"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            required={!pairing.startsWith("linkshell:")}
          />
          <p className="field-hint">电脑需先连接同一个网关。</p>
          <label htmlFor="pairing">配对码或配对链接</label>
          <input
            id="pairing"
            value={pairing}
            onChange={(event) => setPairing(event.target.value)}
            placeholder="6 位配对码，或粘贴 linkshell://pair 链接"
            required
          />
          <p className="field-hint">
            在电脑运行 <code>linkshell pair</code>。有效期 10
            分钟，成功后此浏览器会记住设备。
          </p>
          <button
            className="button primary full"
            disabled={job.busy || state.locked}
          >
            配对并连接
          </button>
          <p className="field-hint">
            自托管不使用 iTool 登录凭证。清除网站数据后需要重新配对。
          </p>
        </form>
      )}
      <ErrorNotice error={job.error} />
      {job.busy && (
        <p className="muted" role="status">
          正在连接…
        </p>
      )}
    </Modal>
  );
}
