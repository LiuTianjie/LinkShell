declare module "qrcode-terminal" {
  export function generate(
    text: string,
    options?: { small?: boolean },
    callback?: (code: string) => void,
  ): void;
}
