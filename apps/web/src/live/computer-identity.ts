import type { Computer } from "./engine";

export function computerAtKey(computers: Computer[], key: string): Computer | undefined {
  return computers.find((computer) => computer.key === key);
}

export function deduplicateLocalComputer(computers: Computer[]): Computer[] {
  return computers;
}
