import { NativeModule, requireOptionalNativeModule } from "expo";

export type LinkSocketEvents = {
  onOpen(event: { id: string }): void;
  onMessage(event: { id: string; data: string }): void;
  onClose(event: { id: string; code: number; reason: string }): void;
  onError(event: { id: string; message: string }): void;
};

declare class LinkSocketNative extends NativeModule<LinkSocketEvents> {
  connect(id: string, url: string, direct: boolean): void;
  send(id: string, text: string): void;
  close(id: string, code: number, reason: string): void;
}

/** The native module, or null where it isn't built in (Android, web). */
export const LinkSocket = requireOptionalNativeModule<LinkSocketNative>("LinkSocket");
