import { useEffect, useMemo, useState } from "react";
import type { Computer } from "./engine";
import { readLocal, saveLocal } from "./storage";

export const computerVisuals = ["pixels", "wave", "dial", "meters", "rings", "columns", "towers", "blocks"] as const;
export type ComputerVisual = typeof computerVisuals[number];
export const computerVisualLabels: Record<ComputerVisual, string> = {
  pixels: "像素", wave: "曲线", dial: "仪表", meters: "刻度",
  rings: "双环", columns: "柱列", towers: "双塔", blocks: "积木",
};
export const computerVisualHasHistory = (visual: ComputerVisual) => visual === "pixels" || visual === "wave" || visual === "columns";
type Visuals = Record<string, ComputerVisual>;
function readVisuals(): Visuals {
  const saved = readLocal<unknown>("computer-visuals", {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, ComputerVisual] => computerVisuals.includes(entry[1] as ComputerVisual)));
}

export function useComputerVisuals(computers: Computer[]) {
  const [saved, setSaved] = useState(readVisuals);
  const visuals = useMemo(() => {
    const next = { ...saved };
    const counts = computerVisuals.map((visual) => computers.filter((computer) => saved[computer.key] === visual).length);
    for (const computer of computers) {
      if (next[computer.key]) continue;
      // Give new computers a different face without changing the ones already in the grid.
      const index = counts.indexOf(Math.min(...counts));
      next[computer.key] = computerVisuals[index]!;
      counts[index] = counts[index]! + 1;
    }
    return next;
  }, [computers, saved]);
  useEffect(() => {
    if (Object.keys(visuals).length === Object.keys(saved).length) return;
    setSaved(visuals);
  }, [visuals, saved]);
  useEffect(() => {
    try { saveLocal("computer-visuals", saved); } catch { /* A visual preference must not interrupt the computer connection. */ }
  }, [saved]);
  return { visuals, change: (key: string, visual: ComputerVisual) => setSaved((current) => ({ ...current, [key]: visual })) };
}
