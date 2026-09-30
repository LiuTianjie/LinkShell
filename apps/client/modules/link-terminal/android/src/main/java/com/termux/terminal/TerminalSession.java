package com.termux.terminal;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * A terminal session backed by a shell on a remote host (LinkShell change: the
 * original ran a local subprocess through JNI).
 * <p>
 * Output from the host is fed in with {@link #feed(byte[])}; everything the
 * user types goes to the {@link Remote}. All calls happen on the main thread.
 */
public final class TerminalSession extends TerminalOutput {

    /** Where keystrokes and size changes go. */
    public interface Remote {
        void input(byte[] data);

        void resize(int columns, int rows);
    }

    public final String mHandle = UUID.randomUUID().toString();

    TerminalEmulator mEmulator;

    /** Callback which gets notified when a session finishes or changes title. */
    TerminalSessionClient mClient;

    /** Set by the application for user identification of session, not by terminal. */
    public String mSessionName;

    private final Remote mRemote;
    private final Integer mTranscriptRows;
    private final byte[] mUtf8InputBuffer = new byte[5];
    private boolean mFinished = false;

    public TerminalSession(Remote remote, Integer transcriptRows, TerminalSessionClient client) {
        this.mRemote = remote;
        this.mTranscriptRows = transcriptRows;
        this.mClient = client;
    }

    public void updateTerminalSessionClient(TerminalSessionClient client) {
        mClient = client;
        if (mEmulator != null) mEmulator.updateTerminalSessionClient(client);
    }

    /** Resize the emulator (creating it on first layout) and tell the host. */
    public void updateSize(int columns, int rows) {
        if (mEmulator == null) {
            mEmulator = new TerminalEmulator(this, columns, rows, mTranscriptRows, mClient);
        } else {
            mEmulator.resize(columns, rows);
        }
        mRemote.resize(columns, rows);
    }

    /** The terminal title as set through escape sequences or null if none set. */
    public String getTitle() {
        return (mEmulator == null) ? null : mEmulator.getTitle();
    }

    /** Output from the host. */
    public void feed(byte[] data) {
        if (mEmulator == null || data.length == 0) return;
        mEmulator.append(data, data.length);
        notifyScreenUpdate();
    }

    /** Keystrokes: to the host. */
    @Override
    public void write(byte[] data, int offset, int count) {
        if (mFinished || count <= 0) return;
        byte[] slice = new byte[count];
        System.arraycopy(data, offset, slice, 0, count);
        mRemote.input(slice);
    }

    /** Write the Unicode code point to the terminal encoded in UTF-8. */
    public void writeCodePoint(boolean prependEscape, int codePoint) {
        if (codePoint > 1114111 || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
            throw new IllegalArgumentException("Invalid code point: " + codePoint);
        }
        int position = 0;
        if (prependEscape) mUtf8InputBuffer[position++] = 27;
        if (codePoint <= 0b1111111) {
            mUtf8InputBuffer[position++] = (byte) codePoint;
        } else if (codePoint <= 0b11111111111) {
            mUtf8InputBuffer[position++] = (byte) (0b11000000 | (codePoint >> 6));
            mUtf8InputBuffer[position++] = (byte) (0b10000000 | (codePoint & 0b111111));
        } else if (codePoint <= 0b1111111111111111) {
            mUtf8InputBuffer[position++] = (byte) (0b11100000 | (codePoint >> 12));
            mUtf8InputBuffer[position++] = (byte) (0b10000000 | ((codePoint >> 6) & 0b111111));
            mUtf8InputBuffer[position++] = (byte) (0b10000000 | (codePoint & 0b111111));
        } else {
            mUtf8InputBuffer[position++] = (byte) (0b11110000 | (codePoint >> 18));
            mUtf8InputBuffer[position++] = (byte) (0b10000000 | ((codePoint >> 12) & 0b111111));
            mUtf8InputBuffer[position++] = (byte) (0b10000000 | ((codePoint >> 6) & 0b111111));
            mUtf8InputBuffer[position++] = (byte) (0b10000000 | (codePoint & 0b111111));
        }
        write(mUtf8InputBuffer, 0, position);
    }

    public TerminalEmulator getEmulator() {
        return mEmulator;
    }

    protected void notifyScreenUpdate() {
        mClient.onTextChanged(this);
    }

    /** Clear the screen and state (a full redraw follows). */
    public void reset() {
        if (mEmulator == null) return;
        mEmulator.reset();
        notifyScreenUpdate();
    }

    /** The remote shell ended: show it and stop sending keys. */
    public void finish(String message) {
        mFinished = true;
        if (mEmulator != null && message != null) {
            byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
            mEmulator.append(bytes, bytes.length);
            notifyScreenUpdate();
        }
        mClient.onSessionFinished(this);
    }

    public void finishIfRunning() {
        mFinished = true;
    }

    public synchronized boolean isRunning() {
        return !mFinished;
    }

    public synchronized int getExitStatus() {
        return 0;
    }

    @Override
    public void titleChanged(String oldTitle, String newTitle) {
        mClient.onTitleChanged(this);
    }

    @Override
    public void onCopyTextToClipboard(String text) {
        mClient.onCopyTextToClipboard(this, text);
    }

    @Override
    public void onPasteTextFromClipboard() {
        mClient.onPasteTextFromClipboard(this);
    }

    @Override
    public void onBell() {
        mClient.onBell(this);
    }

    @Override
    public void onColorsChanged() {
        mClient.onColorsChanged(this);
    }

    public int getPid() {
        return -1;
    }

    public String getCwd() {
        return null;
    }
}
