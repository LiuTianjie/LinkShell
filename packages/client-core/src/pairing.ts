import { codeSecret, idOf, pairingProof, publicIdentity, type Identity, type MachineEntry, type PairingLink, type RelayClient } from "@linkshell/wire";

// The device side of pairing, whichever way the user did it.

/** Pairs using a scanned QR code. The gateway's answer must match the key in the QR. */
export async function pairByLink(relay: RelayClient, device: Identity, link: PairingLink): Promise<MachineEntry> {
  const { machine } = await relay.request(
    "pair.claim",
    { machineId: idOf(link.signKey), proof: pairingProof(link.secret, publicIdentity(device)) },
    40_000,
  );
  if (machine.signKey !== link.signKey) throw new Error("网关返回的电脑和二维码不一致，已拒绝");
  return machine;
}

/** Pairs using the six-digit code shown by `linkshell pair`. */
export async function pairByCode(relay: RelayClient, device: Identity, code: string): Promise<MachineEntry> {
  const digits = code.replace(/\D/g, "");
  const { machine } = await relay.request("pair.claim", { code: digits, proof: pairingProof(codeSecret(digits), publicIdentity(device)) }, 40_000);
  return machine;
}
