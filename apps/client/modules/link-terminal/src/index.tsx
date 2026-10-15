import { requireNativeView } from "expo";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

// Ghostty owns protocol modes, key encoding, cell layout and native input.

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalFile { uri: string; name: string; size?: number }
export interface TerminalKeyModifiers { shift?: boolean; ctrl?: boolean; alt?: boolean }
export interface NativeTerminalHandle {
  supportsReplay(): boolean;
  write(data: string): Promise<void>;
  reset(): Promise<void>;
  focus(): Promise<void>;
  blur(): Promise<void>;
  key(name: string, modifiers?: TerminalKeyModifiers): Promise<void>;
  paste(text: string): Promise<void>;
  pasteClipboard(): Promise<void>;
  toggleCtrl(): Promise<void>;
  beginReplay(reset: boolean): Promise<void>;
  replay(data: string, cols: number, rows: number): Promise<void>;
  endReplay(): Promise<void>;
}

type NativeViewRef = Omit<NativeTerminalHandle, "key" | "supportsReplay"> & {
  key?(name: string, shift: boolean, ctrl: boolean, alt: boolean): Promise<void>;
};
interface NativeProps extends ViewProps {
  theme: TerminalTheme;
  fontSize: number;
  onInput: (event: NativeSyntheticEvent<{ data: string }>) => void;
  onResize: (event: NativeSyntheticEvent<{ cols: number; rows: number }>) => void;
  onFontSize: (event: NativeSyntheticEvent<{ size: number }>) => void;
  onFile: (event: NativeSyntheticEvent<TerminalFile>) => void;
  onError: (event: NativeSyntheticEvent<{ message: string }>) => void;
  onModifiers: (event: NativeSyntheticEvent<{ ctrl: boolean }>) => void;
}
const NativeView = requireNativeView<NativeProps & { ref?: React.Ref<NativeViewRef> }>("LinkTerminal");

export interface NativeTerminalProps extends ViewProps {
  theme: TerminalTheme;
  fontSize: number;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onFontSize: (size: number) => void;
  onFile: (file: TerminalFile) => void;
  onError: (message: string) => void;
  onModifiers: (modifiers: { ctrl: boolean }) => void;
}

function encodeFallbackKey(name: string, modifiers: TerminalKeyModifiers = {}): string | undefined {
  const special: Record<string, string> = {
    enter: modifiers.shift ? "\x1b[13;2u" : "\r",
    escape: "\x1b",
    tab: modifiers.shift ? "\x1b[Z" : "\t",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    backspace: "\x7f",
    home: "\x1b[H",
    end: "\x1b[F",
    pageUp: "\x1b[5~",
    pageDown: "\x1b[6~",
  };
  if (special[name]) {
    const seq = special[name]!;
    return modifiers.alt && !seq.startsWith("\x1b") ? `\x1b${seq}` : seq;
  }
  if (name.length === 1) {
    let ch = modifiers.shift ? name.toUpperCase() : name;
    if (modifiers.ctrl) {
      const code = ch.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) ch = String.fromCharCode(code - 64);
    }
    return modifiers.alt ? `\x1b${ch}` : ch;
  }
  return undefined;
}

export const NativeTerminal = forwardRef<NativeTerminalHandle, NativeTerminalProps>(function NativeTerminal(
  { onInput, onResize, onFile, onError, onModifiers, onFontSize, ...props }, ref,
) {
  const view = useRef<NativeViewRef>(null);
  const mounted = useRef(true);
  const fallbackCtrl = useRef(false);
  const onInputRef = useRef(onInput);
  const onModifiersRef = useRef(onModifiers);
  onInputRef.current = onInput;
  onModifiersRef.current = onModifiers;
  const ready = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!ready.current) {
    let resolve!: () => void;
    ready.current = { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ready.current?.resolve(); };
  }, []);
  useImperativeHandle(ref, () => {
    const call = async (run: (native: NativeViewRef) => Promise<void>) => {
      await ready.current!.promise;
      if (!mounted.current || !view.current) throw new Error("终端视图已关闭");
      await run(view.current);
    };
    return {
      supportsReplay: () => typeof view.current?.beginReplay === "function" && typeof view.current?.replay === "function",
      write: (data) => call((native) => native.write(data)),
      reset: () => call((native) => native.reset()),
      focus: () => call((native) => native.focus()),
      blur: () => call((native) => native.blur()),
      key: (name, modifiers = {}) =>
        call(async (native) => {
          if (typeof native.key === "function") {
            await native.key(name, !!modifiers.shift, !!modifiers.ctrl, !!modifiers.alt);
            return;
          }
          const seq = encodeFallbackKey(name, { ...modifiers, ctrl: modifiers.ctrl || fallbackCtrl.current });
          if (fallbackCtrl.current) {
            fallbackCtrl.current = false;
            onModifiersRef.current({ ctrl: false });
          }
          if (seq) onInputRef.current(seq);
        }),
      paste: (text) =>
        call(async (native) => {
          if (typeof native.paste === "function") {
            await native.paste(text);
          } else {
            onInputRef.current(text);
          }
        }),
      pasteClipboard: () =>
        call(async (native) => {
          if (typeof native.pasteClipboard === "function") {
            await native.pasteClipboard();
          }
        }),
      toggleCtrl: () =>
        call(async (native) => {
          if (typeof native.toggleCtrl === "function") {
            await native.toggleCtrl();
          } else {
            fallbackCtrl.current = !fallbackCtrl.current;
            onModifiersRef.current({ ctrl: fallbackCtrl.current });
          }
        }),
      beginReplay: (reset) =>
        call(async (native) => {
          if (typeof native.beginReplay === "function") {
            await native.beginReplay(reset);
          } else if (reset && typeof native.reset === "function") {
            await native.reset();
          }
        }),
      replay: (data, cols, rows) =>
        call(async (native) => {
          if (typeof native.replay === "function") {
            await native.replay(data, cols, rows);
          } else {
            await native.write(data);
          }
        }),
      endReplay: () =>
        call(async (native) => {
          if (typeof native.endReplay === "function") {
            await native.endReplay();
          }
        }),
    };
  }, []);
  return <NativeView {...props} ref={view}
    onInput={(event) => {
      const raw = event.nativeEvent.data;
      if (fallbackCtrl.current && raw.length === 1) {
        fallbackCtrl.current = false;
        onModifiers({ ctrl: false });
        const seq = encodeFallbackKey(raw, { ctrl: true });
        if (seq) {
          onInput(seq);
          return;
        }
      }
      onInput(raw);
    }}
    onResize={(event) => { ready.current?.resolve(); onResize(event.nativeEvent.cols, event.nativeEvent.rows); }}
    onFontSize={(event) => onFontSize?.(event.nativeEvent.size)}
    onFile={(event) => onFile?.(event.nativeEvent)}
    onError={(event) => onError?.(event.nativeEvent.message)}
    onModifiers={(event) => onModifiers?.(event.nativeEvent)}
  />;
});
