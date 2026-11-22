import Storage from "expo-sqlite/kv-store";
import { useEffect, useState } from "react";
import type { HostLink } from "@linkshell/client-core";
import { useClient, useConnection } from "./client";

const inflight = new WeakMap<HostLink, { id: string; read: Promise<string | undefined> }>();
const memory = new Map<string, string>();

function remember(id: string, uri: string): void {
  if (memory.has(id)) memory.delete(id);
  else if (memory.size >= 16) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  memory.set(id, uri);
}

function fromHost(id: string, link: HostLink): Promise<string | undefined> {
  const previous = inflight.get(link);
  if (previous?.id === id) return previous.read;
  const read = link.call("machine.artwork", { id }).then(async ({ webp }) => {
    if (!webp) return undefined;
    await Storage.setItemAsync(`computer-art:${id}`, webp).catch(() => {});
    return webp;
  }).finally(() => { if (inflight.get(link)?.read === read) inflight.delete(link); });
  inflight.set(link, { id, read });
  return read;
}

export function useComputerArtwork(id?: string): string | undefined {
  const { link } = useConnection();
  const selected = useClient((state) => !state.machine?.locked && state.machine?.hardwareModel?.artworkId === id && state.status === "online");
  const [image, setImage] = useState<{ id: string; uri: string } | undefined>(() => {
    const uri = id ? memory.get(id) : undefined;
    return id && uri ? { id, uri } : undefined;
  });
  useEffect(() => {
    if (!id) return;
    const cached = memory.get(id);
    if (cached) {
      remember(id, cached);
      setImage({ id, uri: cached });
      return;
    }
    let current = true;
    void (async () => {
      // Shared by the three views, survives an offline switch, and doesn't bulk up every settings write.
      const data = await Storage.getItemAsync(`computer-art:${id}`).catch(() => null) ?? (selected ? await fromHost(id, link) : undefined);
      if (current && data) {
        const uri = `data:image/webp;base64,${data}`;
        remember(id, uri);
        setImage({ id, uri });
      }
    })().catch(() => {});
    return () => { current = false; };
  }, [id, selected, link]);
  return (id && memory.get(id)) ?? (image && image.id === id ? image.uri : undefined);
}
