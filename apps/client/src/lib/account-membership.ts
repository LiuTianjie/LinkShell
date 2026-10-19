import { fetchProMembership, redeemProCode } from "@linkshell/client-core";
import accountConfig from "../../config/account.json";
import { useAccount } from "./account";

async function tokenFor(userId: string): Promise<string> {
  if (useAccount.getState().session?.userId !== userId) throw new Error("账号已切换，请重新打开账户页");
  const accessToken = await useAccount.getState().token();
  // Token refresh may finish after the user signs out or switches accounts.
  if (useAccount.getState().session?.userId !== userId) throw new Error("账号已切换，请重新打开账户页");
  if (!accessToken) throw new Error("登录已失效，请重新登录");
  return accessToken;
}

export async function loadAccountMembership(userId: string) {
  return fetchProMembership({
    supabaseUrl: accountConfig.url,
    anonKey: accountConfig.anonKey,
    accessToken: await tokenFor(userId),
    userId,
  });
}

export async function redeemAccountCode(userId: string, code: string) {
  return redeemProCode(await tokenFor(userId), code);
}
