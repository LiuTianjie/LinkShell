import { requireNativeView } from "expo";
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

// Native terminal: SwiftTerm on iOS, Termux's terminal view on Android. Both
// render natively and take keyboard input (every IME, in place) themselves.

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

export interface NativeTerminalHandle {
  /** Output from the host. */
  write(data: string): void;
  /** Clear screen and state, before a full redraw. */
  reset(): void;
  /** Show the keyboard. */
  focus(): void;
  /** Hide the keyboard. */
  blur(): void;
}

interface NativeProps extends ViewProps {
  theme: TerminalTheme;
  fontSize: number;
  onInput: (event: NativeSyntheticEvent<{ data: string }>) => void;
  onResize: (event: NativeSyntheticEvent<{ cols: number; rows: number }>) => void;
}

type NativeViewRef = {
  write(data: string): Promise<void>;
  reset(): Promise<void>;
  focus(): Promise<void>;
  blur(): Promise<void>;
};

const NativeView = requireNativeView<NativeProps & { ref?: React.Ref<NativeViewRef> }>("LinkTerminal");

export interface NativeTerminalProps extends ViewProps {
  theme: TerminalTheme;
  fontSize: number;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export const NativeTerminal = forwardRef<NativeTerminalHandle, NativeTerminalProps>(function NativeTerminal(
  { onInput, onResize, ...props },
  ref,
) {
  const view = useRef<NativeViewRef>(null);
  useImperativeHandle(
    ref,
    () => ({
      write: (data) => void view.current?.write(data),
      reset: () => void view.current?.reset(),
      focus: () => void view.current?.focus(),
      blur: () => void view.current?.blur(),
    }),
    [],
  );
  return (
    <NativeView
      {...props}
      ref={view}
      onInput={(event) => onInput(event.nativeEvent.data)}
      onResize={(event) => onResize(event.nativeEvent.cols, event.nativeEvent.rows)}
    />
  );
});
