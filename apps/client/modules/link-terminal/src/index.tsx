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

type NativeViewRef = Omit<NativeTerminalHandle, "key"> & {
  key(name: string, shift: boolean, ctrl: boolean, alt: boolean): Promise<void>;
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

export const NativeTerminal = forwardRef<NativeTerminalHandle, NativeTerminalProps>(function NativeTerminal(
  { onInput, onResize, onFile, onError, onModifiers, onFontSize, ...props }, ref,
) {
  const view = useRef<NativeViewRef>(null);
  const mounted = useRef(true);
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
      write: (data) => call((native) => native.write(data)),
      reset: () => call((native) => native.reset()),
      focus: () => call((native) => native.focus()),
      blur: () => call((native) => native.blur()),
      key: (name, modifiers = {}) => call((native) => native.key(name, !!modifiers.shift, !!modifiers.ctrl, !!modifiers.alt)),
      paste: (text) => call((native) => native.paste(text)),
      pasteClipboard: () => call((native) => native.pasteClipboard()),
      toggleCtrl: () => call((native) => native.toggleCtrl()),
      beginReplay: (reset) => call((native) => native.beginReplay(reset)),
      replay: (data, cols, rows) => call((native) => native.replay(data, cols, rows)),
      endReplay: () => call((native) => native.endReplay()),
    };
  }, []);
  return <NativeView {...props} ref={view}
    onInput={(event) => onInput(event.nativeEvent.data)}
    onResize={(event) => { ready.current?.resolve(); onResize(event.nativeEvent.cols, event.nativeEvent.rows); }}
    onFontSize={(event) => onFontSize(event.nativeEvent.size)}
    onFile={(event) => onFile(event.nativeEvent)}
    onError={(event) => onError(event.nativeEvent.message)}
    onModifiers={(event) => onModifiers(event.nativeEvent)}
  />;
});
