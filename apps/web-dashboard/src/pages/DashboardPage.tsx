import { useEffect, useState } from "react";
import { signOut, fetchApi } from "../lib/supabase";
import type { Session } from "../lib/supabase";

interface DeviceToken {
  id: string;
  token: string;
  device_name: string | null;
  platform: string | null;
  last_used_at: string;
}

interface Subscription {
  id: string;
  plan: string;
  status: string;
  provider: string;
  current_period_end: string | null;
}

export function DashboardPage({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const [devices, setDevices] = useState<DeviceToken[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [devs, subs] = await Promise.all([
        fetchApi<DeviceToken[]>(
          `linkshell_device_tokens?user_id=eq.${session.user.id}&order=last_used_at.desc`,
          session,
        ),
        fetchApi<Subscription[]>(
          `linkshell_subscriptions?user_id=eq.${session.user.id}&status=eq.active&limit=1`,
          session,
        ),
      ]);
      setDevices(devs ?? []);
      setSubscription(subs?.[0] ?? null);
      setLoading(false);
    }
    load();
  }, [session]);

  const handleLogout = async () => {
    await signOut();
    onLogout();
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">LinkShell Dashboard</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-400">{session.user.email}</span>
          <button
            onClick={handleLogout}
            className="text-sm text-gray-400 hover:text-white transition"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        {/* Subscription */}
        <section>
          <h2 className="text-lg font-semibold mb-3">Subscription</h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
            {loading ? (
              <p className="text-gray-500">Loading...</p>
            ) : subscription ? (
              <div className="flex items-center justify-between">
                <div>
                  <span className="inline-block px-2.5 py-0.5 rounded-full bg-green-900 text-green-300 text-xs font-medium">
                    {subscription.plan.toUpperCase()}
                  </span>
                  <p className="text-sm text-gray-400 mt-1">
                    via {subscription.provider}
                    {subscription.current_period_end &&
                      ` · renews ${new Date(subscription.current_period_end).toLocaleDateString()}`}
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <p className="text-gray-400">Free plan</p>
                <p className="text-sm text-gray-500 mt-1">
                  Upgrade to Pro for managed gateway access.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Devices */}
        <section>
          <h2 className="text-lg font-semibold mb-3">
            Devices{" "}
            <span className="text-sm text-gray-500 font-normal">
              ({devices.length})
            </span>
          </h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 divide-y divide-gray-800">
            {loading ? (
              <div className="p-5 text-gray-500">Loading...</div>
            ) : devices.length === 0 ? (
              <div className="p-5 text-gray-500">
                No devices linked yet. Log in from the mobile app or CLI to link
                a device.
              </div>
            ) : (
              devices.map((d) => (
                <div
                  key={d.id}
                  className="px-5 py-3 flex items-center justify-between"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {d.device_name || "Unknown device"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {d.platform ?? "—"} · last used{" "}
                      {new Date(d.last_used_at).toLocaleDateString()}
                    </p>
                  </div>
                  <code className="text-xs text-gray-600 font-mono">
                    {d.token.slice(0, 8)}...
                  </code>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
