import { useEffect, useRef, useState } from "react";
import { messageOf } from "./common";
import { cancelDesktopLogin, desktopLogin, desktopLoginState, type DesktopSignIn } from "./desktop";
import type { SignInMethod, SignInProps } from "./SignIn";

const LINK_POLL_MS = 400;

function problem(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "等待登录超时，请重试。";
  if (error instanceof TypeError) return "桌面服务暂时不可用，请重试。";
  return messageOf(error);
}

/**
 * The workspace's sign-in (the Connect dialog), through the workspace service: it signs in,
 * writes the account file and opens the browser; the page only learns the provider's link, to
 * reopen or copy it. Leaving the page ends a sign-in still waiting on the browser.
 */
export function useDesktopSignIn(signedIn: () => Promise<void>): Omit<SignInProps, "disabled" | "title" | "description"> {
  const [pending, setPending] = useState<SignInMethod>();
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const cancelled = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (running.current) {
        cancelled.current = true;
        void cancelDesktopLogin().catch(() => undefined);
      }
    };
  }, []);

  const start = async (request: DesktopSignIn) => {
    if (running.current) return;
    running.current = true;
    cancelled.current = false;
    setPending(request.method);
    setLink(undefined);
    setError(undefined);
    // The service learns the link once its loopback listens, a moment after the request starts.
    let watching = request.method === "github" || request.method === "google";
    const watch = async () => {
      while (watching) {
        await new Promise((resolve) => setTimeout(resolve, LINK_POLL_MS));
        if (!watching) return;
        try {
          const state = await desktopLoginState();
          if (watching && state?.method === request.method && state.url) { setLink(state.url); return; }
        } catch { /* Try again on the next tick; the sign-in itself reports real failures. */ }
      }
    };
    if (watching) void watch();
    try {
      await desktopLogin(request);
      if (mounted.current) await signedIn();
    } catch (failure) {
      if (!cancelled.current && mounted.current) setError(problem(failure));
    } finally {
      watching = false;
      running.current = false;
      if (mounted.current) { setPending(undefined); setLink(undefined); }
    }
  };

  return {
    pending,
    link,
    error,
    onPassword: (email, password) => void start({ method: "password", email, password }),
    onProvider: (provider) => void start({ method: provider }),
    onBrowser: () => void start({ method: "web" }),
    onCancel: () => {
      cancelled.current = true;
      void cancelDesktopLogin().catch(() => undefined);
    },
    onEdit: () => setError(undefined),
  };
}
