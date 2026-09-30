The `com.termux.terminal` and `com.termux.view` packages are the terminal-emulator
and terminal-view libraries from termux-app v0.118.1 (https://github.com/termux/termux-app),
Apache License 2.0, originally derived from jackpal/Android-Terminal-Emulator.

LinkShell change: TerminalSession no longer spawns a local process (JNI removed);
it is fed by, and writes to, a shell on a remote host.
