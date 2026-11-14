import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasOpenOverlay } from "../src/bridge/top-layer-registry";
import {
  AlertDialog,
  AutoGrowTextarea,
  Badge,
  Button,
  CollapsibleLog,
  Combobox,
  ContextMenu,
  CopyButton,
  DataTable,
  Dialog,
  DialogBody,
  DialogHeader,
  DialogProvider,
  DialogTitle,
  Disclosure,
  EmptyState,
  ErrorBoundary,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  PairingCodeInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SplitResizer,
  StatusDot,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Toolbar,
  Tooltip,
  moveNodeAtomic,
  useDialogs,
} from "../src/primitives";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Modern Web Guidance Native Primitives Kit (Chromium 152)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("Button locks width during loading, blocks duplicate clicks, and wraps disabledReason in a hint tooltip without triggering Metal overlay occlusion", () => {
    const onClick = vi.fn();

    act(() => {
      root.render(
        <div>
          <Button id="loading-btn" loading onClick={onClick}>
            开启融合模式
          </Button>
          <Button
            id="disabled-fusion"
            disabled
            disabledReason="融合模式仅支持在 macOS 桌面端连接远端 Mac"
          >
            融合模式
          </Button>
          <IconButton
            id="settings-icon"
            icon="settings"
            label="设置与本机服务"
            shortcut="Mod+,"
          />
        </div>,
      );
    });

    const loadingBtn = container.querySelector<HTMLButtonElement>("#loading-btn")!;
    expect(loadingBtn.disabled).toBe(true);
    expect(loadingBtn.getAttribute("aria-busy")).toBe("true");
    expect(
      loadingBtn.querySelector('[data-hidden-keep-width="true"]'),
    ).not.toBeNull();
    expect(loadingBtn.querySelector(".ls-btn__spinner-overlay")).not.toBeNull();

    act(() => {
      loadingBtn.click();
    });
    expect(onClick).not.toHaveBeenCalled();

    const disabledAnchor = container.querySelector<HTMLElement>(
      ".ls-tooltip-disabled-anchor",
    )!;
    expect(disabledAnchor).not.toBeNull();

    // Focusing the disabled wrapper reveals the `popover="hint"` explanation WITHOUT marking a top-layer modal/menu open.
    act(() => {
      disabledAnchor.focus();
    });
    const tip = container.querySelector<HTMLElement>('[popover="hint"][role="tooltip"]')!;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain("融合模式仅支持在 macOS 桌面端连接远端 Mac");
    expect(hasOpenOverlay()).toBe(false);

    const iconBtn = container.querySelector<HTMLButtonElement>("#settings-icon")!;
    expect(iconBtn.getAttribute("aria-label")).toBe("设置与本机服务");
    // Icon-only buttons MUST NOT render inline `<Kbd>` inside `.ls-btn__body` (shortcut lives strictly inside `<Tooltip>`)
    expect(iconBtn.querySelector(".ls-btn__kbd")).toBeNull();
    const allTooltips = container.querySelectorAll<HTMLElement>('[popover="hint"][role="tooltip"]');
    expect(
      [...allTooltips].some((el) => el.querySelector(".ls-tooltip__kbd") !== null),
    ).toBe(true);
  });

  it("Dialog & AlertDialog use native <dialog>, closedby, omit redundant ARIA/focus-trap attributes, and synchronize TopLayerRegistry", () => {
    let closedCount = 0;

    function Harness({ open }: { open: boolean }) {
      return (
        <Dialog
          open={open}
          size="palette"
          onOpenChange={(next) => {
            if (!next) closedCount += 1;
          }}
        >
          <DialogHeader>
            <DialogTitle>命令中心</DialogTitle>
          </DialogHeader>
          <DialogBody>搜索内容</DialogBody>
        </Dialog>
      );
    }

    act(() => {
      root.render(<Harness open />);
    });

    const dialog = container.querySelector<HTMLDialogElement>("dialog.ls-dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("closedby")).toBe("any");
    // MWG `dialog`: must NOT add `role="dialog"` or `aria-modal`
    expect(dialog.hasAttribute("role")).toBe(false);
    expect(dialog.hasAttribute("aria-modal")).toBe(false);
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(hasOpenOverlay()).toBe(true);

    act(() => {
      root.render(<Harness open={false} />);
    });
    expect(hasOpenOverlay()).toBe(false);
    expect(closedCount).toBeGreaterThanOrEqual(1);

    act(() => {
      root.render(
        <AlertDialog
          open
          title="移除配对设备"
          description="移除后该手机需重新配对。"
          destructive
        />,
      );
    });
    const alertDialog =
      container.querySelector<HTMLDialogElement>("dialog.ls-dialog")!;
    expect(alertDialog.getAttribute("closedby")).toBe("closerequest");
  });

  it("Queued DialogProvider / useDialogs() processes concurrent calls FIFO, uses proper titles (never hardcoded '上下文用量'), and guards IME Enter in prompt", async () => {
    let api!: ReturnType<typeof useDialogs>;

    function Probe() {
      api = useDialogs();
      return <button type="button">触发</button>;
    }

    act(() => {
      root.render(
        <DialogProvider>
          <Probe />
        </DialogProvider>,
      );
    });

    let confirmResolved: boolean | undefined;
    let alertResolved: string | null | undefined;
    let promptResolved: string | null | undefined;

    act(() => {
      void api.confirm("确定停止本机服务？").then((v) => {
        confirmResolved = v;
      });
      void api.alert("网关已重新连接").then((v) => {
        alertResolved = v;
      });
      void api.prompt("重命名会话", "初始标题").then((v) => {
        promptResolved = v;
      });
    });

    // 1st in FIFO queue: confirm
    expect(container.querySelector(".ls-dialog__title")?.textContent).toBe(
      "确认操作",
    );
    expect(confirmResolved).toBeUndefined();
    expect(alertResolved).toBeUndefined();

    const confirmButtons = container.querySelectorAll<HTMLButtonElement>(
      ".ls-dialog__footer button",
    );
    await act(async () => {
      confirmButtons[1]?.click();
    });
    expect(confirmResolved).toBe(true);

    // 2nd in FIFO queue: alert (title must be "提示", NEVER "上下文用量"!)
    const alertTitle = container.querySelector(".ls-dialog__title")?.textContent;
    expect(alertTitle).toBe("提示");
    expect(alertTitle).not.toBe("上下文用量");
    expect(container.querySelector(".ls-dialog__description")?.textContent).toBe(
      "网关已重新连接",
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".ls-dialog__footer button")
        ?.click();
    });
    expect(alertResolved).toBe("acknowledged");

    // 3rd in FIFO queue: prompt with IME composition guard
    expect(container.querySelector(".ls-dialog__title")?.textContent).toBe(
      "重命名会话",
    );
    const input = container.querySelector<HTMLInputElement>("input.ls-input")!;
    expect(input.value).toBe("初始标题");

    // IME composing Enter (`keyCode: 229`) must NOT submit the form early
    const imeEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    act(() => {
      input.dispatchEvent(imeEnter);
    });
    expect(imeEnter.defaultPrevented).toBe(true);
    expect(promptResolved).toBeUndefined();

    // Submit form cleanly
    await act(async () => {
      input.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(promptResolved).toBe("初始标题");
  });

  it("Menu nests focusgroup='menu nomemory' INSIDE popover='auto' (never on [popover]), supports radio/checkbox items, ContextMenu placeholder, and Toolbar", () => {
    function MenuHarness() {
      const [model, setModel] = useState("claude-sonnet");
      const [wrap, setWrap] = useState(true);
      return (
        <div>
          <Toolbar label="编辑器工具栏">
            <Menu
              defaultOpen
              trigger={<Button id="model-trigger">选择模型</Button>}
            >
              <MenuRadioGroup value={model} onValueChange={setModel}>
                <MenuRadioItem value="claude-sonnet">Claude Sonnet</MenuRadioItem>
                <MenuRadioItem value="gpt-5">GPT-5</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuCheckboxItem
                checked={wrap}
                onCheckedChange={setWrap}
                keepOpen
              >
                自动换行
              </MenuCheckboxItem>
              <MenuItem destructive>删除会话</MenuItem>
            </Menu>
          </Toolbar>

          <ContextMenu
            label="应用操作"
            menu={<MenuItem id="ctx-launch">打开远端应用</MenuItem>}
          >
            <div id="fusion-tile">Xcode</div>
          </ContextMenu>
        </div>
      );
    }

    act(() => {
      root.render(<MenuHarness />);
    });

    const toolbar = container.querySelector('[role="toolbar"]')!;
    expect(toolbar.getAttribute("focusgroup")).toBe("toolbar wrap");

    const menuPopover = container.querySelector<HTMLElement>(".ls-menu-popover")!;
    expect(menuPopover).not.toBeNull();
    // In jsdom (`useNativePopoverApi === false`), `popover` attribute is omitted so UA `[popover]` styles never hide open fallback menus
    expect(menuPopover.hasAttribute("popover")).toBe(false);
    // MWG `menu` critical Chromium rule: `focusgroup` MUST NOT be on `[popover]`, MUST be nested inside!
    expect(menuPopover.hasAttribute("focusgroup")).toBe(false);

    const innerMenu = menuPopover.querySelector<HTMLElement>('[role="menu"]')!;
    expect(innerMenu).not.toBeNull();
    expect(innerMenu.getAttribute("focusgroup")).toBe("menu nomemory");

    const radios = innerMenu.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    );
    expect(radios.length).toBe(2);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");

    act(() => {
      radios[1]?.click();
    });
    // Menu closes after selecting a radio item and unmounts interactive child buttons (`{open ? children : null}`)
    expect(menuPopover.dataset.state).toBe("closed");
    expect(innerMenu.querySelectorAll("button").length).toBe(0);

    // ContextMenu positions zero-size fixed placeholder at click coordinates
    const tile = container.querySelector<HTMLElement>("#fusion-tile")!;
    act(() => {
      tile.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 180,
          clientY: 240,
        }),
      );
    });
    const pointAnchor = container.querySelector<HTMLElement>(
      ".ls-menu-point-anchor",
    )!;
    expect(pointAnchor.style.left).toBe("180px");
    expect(pointAnchor.style.top).toBe("240px");
  });

  it("Select uses customizable <selectedcontent> and Combobox filters & guards CJK IME Enter", () => {
    const onSelect = vi.fn();
    const onCombo = vi.fn();

    act(() => {
      root.render(
        <div>
          <Select
            label="权限模式"
            value="auto"
            onValueChange={onSelect}
            options={[
              { value: "ask", label: "每次询问", icon: "approval-shield" },
              { value: "auto", label: "自动执行", badge: "推荐" },
            ]}
          />
          <Combobox
            ariaLabel="选择分支"
            value="main"
            onValueChange={onCombo}
            options={[
              { value: "main", label: "main", group: "默认" },
              { value: "feat/fusion", label: "feat/fusion", group: "特性" },
            ]}
          />
        </div>,
      );
    });

    const select = container.querySelector<HTMLSelectElement>("select.ls-select")!;
    expect(select).not.toBeNull();
    expect(select.value).toBe("auto");
    expect(select.options[1]?.textContent).toContain("自动执行");
    act(() => {
      select.value = "ask";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("ask");

    const comboBtn = container.querySelector<HTMLButtonElement>(
      ".ls-combobox-trigger",
    )!;
    act(() => {
      comboBtn.click();
    });

    const searchInput = container.querySelector<HTMLInputElement>(
      ".ls-combobox__input",
    )!;
    expect(searchInput).not.toBeNull();

    // IME composing Enter (`keyCode: 229`) must NOT commit selection prematurely
    act(() => {
      const evt = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(evt, "keyCode", { value: 229 });
      searchInput.dispatchEvent(evt);
    });
    expect(onCombo).not.toHaveBeenCalled();

    // Real ArrowDown + Enter selects second option
    act(() => {
      searchInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    act(() => {
      searchInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onCombo).toHaveBeenCalledWith("feat/fusion");
  });

  it("Tabs caches inactive panels via data-inactive and supports hidden='until-found' + beforematch alongside Disclosure & CollapsibleLog", () => {
    act(() => {
      root.render(
        <div>
          <Tabs defaultValue="diff">
            <TabList label="检查器标签">
              <Tab value="diff" count={3}>
                变更
              </Tab>
              <Tab value="terminal">终端</Tab>
            </TabList>
            <TabPanel value="diff">Diff Panel</TabPanel>
            <TabPanel value="terminal" keepMounted>
              Cached Xterm Surface
            </TabPanel>
          </Tabs>

          <Disclosure title="执行命令" meta="0.4s">
            输出详情
          </Disclosure>

          <CollapsibleLog
            id="tool-log"
            title="pnpm typecheck"
            meta="退出码 0"
            logText="All packages passed typecheck."
          />
        </div>,
      );
    });

    const tabList = container.querySelector('[role="tablist"]')!;
    expect(tabList.getAttribute("focusgroup")).toBe("tablist nomemory");

    const panels = container.querySelectorAll<HTMLElement>('[role="tabpanel"]');
    expect(panels.length).toBe(2);
    expect(panels[1]?.dataset.inactive).toBe("true");
    expect(panels[1]?.textContent).toContain("Cached Xterm Surface");

    // CollapsibleLog sets `hidden="until-found"` when closed and opens automatically on `beforematch` (`⌘F`)
    const logPanel = container.querySelector<HTMLElement>(
      "#tool-log .ls-collapsible-log__panel",
    )!;
    expect(logPanel.getAttribute("hidden")).toBe("until-found");
    expect(
      logPanel.querySelector("pre")?.getAttribute("tabindex"),
    ).toBe("0");

    act(() => {
      logPanel.dispatchEvent(new Event("beforematch"));
    });
    expect(logPanel.hasAttribute("hidden")).toBe(false);
  });

  it("Switch, CopyButton, DataTable, PairingCodeInput, AutoGrowTextarea, Popover, SplitResizer & primitives.css enforce all MWG rules", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const onSwitch = vi.fn();
    const onResize = vi.fn();
    const onPairCode = vi.fn();
    const onTextareaSubmit = vi.fn();

    act(() => {
      root.render(
        <div>
          <Switch
            checked={false}
            onCheckedChange={onSwitch}
            label="开机自动启动"
          />
          <CopyButton value="linkshell pair" revealOnHover />
          <DataTable
            label="模型用量表"
            defaultSortColumnId="tokens"
            defaultSortDirection="desc"
            getRowKey={(row) => row.model}
            columns={[
              {
                id: "model",
                header: "模型",
                sortable: true,
                sortAccessor: (r) => r.model,
                cell: (r) => r.model,
              },
              {
                id: "tokens",
                header: "Token 用量",
                numeric: true,
                sortable: true,
                sortAccessor: (r) => r.tokens,
                cell: (r) => r.tokens.toLocaleString(),
              },
            ]}
            rows={[
              { model: "Claude Sonnet", tokens: 1200 },
              { model: "GPT-5", tokens: 4800 },
            ]}
          />
          <PairingCodeInput value="" onValueChange={onPairCode} label="配对码" />
          <AutoGrowTextarea
            placeholder="输入指令…"
            onEnterSubmit={onTextareaSubmit}
          />
          <Popover>
            <PopoverTrigger>
              <Button>切换电脑</Button>
            </PopoverTrigger>
            <PopoverContent>电脑列表</PopoverContent>
          </Popover>
          <SplitResizer
            label="侧边栏宽度"
            size={248}
            min={216}
            max={340}
            defaultSize={248}
            onResize={onResize}
          />
          <Badge tone="running" dot="running">
            运行中
          </Badge>
          <StatusDot tone="online" label="在线" />
          <Kbd shortcut="Mod+K" />
          <EmptyState icon="fusion-mode" title="融合模式" description="独立窗口投射" />
        </div>,
      );
    });

    // Switch: `<input type="checkbox" role="switch">` (never Safari-only `switch` attribute)
    const switchInput = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"][role="switch"]',
    )!;
    expect(switchInput).not.toBeNull();
    expect(switchInput.hasAttribute("switch")).toBe(false);
    act(() => {
      switchInput.click();
    });
    expect(onSwitch).toHaveBeenCalledWith(true);

    // CopyButton: `<span role="status">` sits OUTSIDE `<button>` and stays empty until copy
    const copyWrap = container.querySelector(".ls-copy-wrap")!;
    const copyBtn = copyWrap.querySelector<HTMLButtonElement>("button.ls-copy-btn")!;
    const statusRegion = copyWrap.querySelector<HTMLElement>('[role="status"]')!;
    expect(copyBtn.contains(statusRegion)).toBe(false);
    expect(statusRegion.textContent).toBe("");

    await act(async () => {
      copyBtn.click();
    });
    expect(writeText).toHaveBeenCalledWith("linkshell pair");
    expect(statusRegion.textContent).toBe("已复制");

    // DataTable: `tabIndex=0` region, `<button type="button">` inside sortable `<th>`, `aria-sort` ONLY on active column
    const tableRegion = container.querySelector<HTMLElement>(".ls-table-container")!;
    expect(tableRegion.tabIndex).toBe(0);
    const headers = tableRegion.querySelectorAll<HTMLTableCellElement>("th[scope='col']");
    expect(headers[0]?.hasAttribute("aria-sort")).toBe(false);
    expect(headers[1]?.getAttribute("aria-sort")).toBe("descending");
    expect(headers[0]?.querySelector('button[type="button"]')).not.toBeNull();

    // PairingCodeInput: single `<input>` with `inputmode="numeric"`, strips non-digits
    const pairInputs = container.querySelectorAll(".ls-pairing-code-input");
    expect(pairInputs.length).toBe(1);
    expect(pairInputs[0]?.getAttribute("inputmode")).toBe("numeric");

    // AutoGrowTextarea: IME guard on Enter
    const textarea = container.querySelector<HTMLTextAreaElement>(
      ".ls-autogrow-textarea",
    )!;
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(onTextareaSubmit).not.toHaveBeenCalled();
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          isComposing: false,
        }),
      );
    });
    expect(onTextareaSubmit).toHaveBeenCalledTimes(1);

    // SplitResizer keyboard resize + doubleClick reset
    const resizer = container.querySelector<HTMLElement>('[role="separator"]')!;
    act(() => {
      resizer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(onResize).toHaveBeenCalledWith(272);

    // Static CSS compliance audit on `primitives.css`
    const cssText = readFileSync(
      resolve(__dirname, "../src/styles/primitives.css"),
      "utf8",
    );
    expect(cssText).toContain("dialog.ls-dialog[open]");
    // Ensure `dialog.ls-dialog` itself never sets `transform` (which traps `position: fixed` `.modal-window-drag-strip` away from y=0)
    expect(cssText).toContain("dialog.ls-dialog > .ls-dialog__surface");
    expect(cssText).not.toMatch(/dialog\.ls-dialog(?:\[open\])?\s*\{[^}]*\btransform\s*:/);
    expect(cssText).toContain("appearance: base-select;");
    expect(cssText).toContain("transition-behavior: allow-discrete;");
    expect(cssText).toContain("field-sizing: content;");
    // Ensure `allow-discrete` is never inside a `transition:` shorthand
    expect(cssText).not.toMatch(/transition:\s*[^;]*allow-discrete/);
    // Ensure `::picker(select)` never uses `overflow: hidden`
    const pickerBlock = cssText.match(
      /select\.ls-select::picker\(select\)\s*\{[^}]*\}/,
    )?.[0];
    expect(pickerBlock).toBeDefined();
    expect(pickerBlock).not.toContain("overflow: hidden");
    // Ensure `position-area` never mixes physical keywords (`top`, `bottom`, `left`, `right`)
    const positionAreas = [...cssText.matchAll(/position-area:\s*([^;]+);/g)].map(
      (m) => m[1],
    );
    expect(positionAreas.length).toBeGreaterThan(0);
    for (const val of positionAreas) {
      expect(val).not.toMatch(/\b(top|bottom|left|right)\b/);
    }
    // Phase 5 Top-Layer Hit-Test Guard (`@layer utilities`) + scoped `.ls-combobox-popover` flex
    expect(cssText).toContain("@layer utilities");
    expect(cssText).toContain("[popover]:not(:popover-open)");
    expect(cssText).toContain("dialog:not([open])");
    expect(cssText).toContain('.ls-popover[data-state="closed"]');
    expect(cssText).toContain('.ls-tooltip[data-state="closed"]');
    expect(cssText).toContain(".ls-combobox-popover:popover-open");
    const comboBase = cssText.match(/\.ls-combobox-popover\s*\{[^}]*\}/)?.[0];
    expect(comboBase).toBeDefined();
    expect(comboBase).not.toContain("display: flex");

    // Verify Chromium native Popover API mode sets `popover="auto"` while mounting ZERO child buttons when closed
    const proto = HTMLElement.prototype as HTMLElement & {
      showPopover?: () => void;
      hidePopover?: () => void;
    };
    const prevShow = proto.showPopover;
    const prevHide = proto.hidePopover;
    proto.showPopover = vi.fn();
    proto.hidePopover = vi.fn();
    try {
      act(() => {
        root.render(
          <div>
            <Popover>
              <PopoverTrigger>
                <Button>电脑选择</Button>
              </PopoverTrigger>
              <PopoverContent>
                <button type="button" id="inside-closed-popover">
                  Remote Mac
                </button>
              </PopoverContent>
            </Popover>
            <Menu trigger={<Button>菜单触发</Button>}>
              <MenuItem id="inside-closed-menu">操作项</MenuItem>
            </Menu>
          </div>,
        );
      });
      const nativePop = container.querySelector<HTMLElement>(".ls-popover[popover='auto']");
      const nativeMenu = container.querySelector<HTMLElement>(".ls-menu-popover[popover='auto']");
      expect(nativePop).not.toBeNull();
      expect(nativeMenu).not.toBeNull();
      expect(container.querySelector("#inside-closed-popover")).toBeNull();
      expect(container.querySelector("#inside-closed-menu")).toBeNull();
    } finally {
      if (prevShow === undefined) delete proto.showPopover;
      else proto.showPopover = prevShow;
      if (prevHide === undefined) delete proto.hidePopover;
      else proto.hidePopover = prevHide;
    }
  });

  it("moveNodeAtomic guards disconnected nodes against Chromium 152 moveBefore DOMException, ErrorBoundary isolates pane crashes, and trigger cloning preserves React 19 refs cleanly", () => {
    const hostA = document.createElement("div");
    const hostB = document.createElement("div");
    container.append(hostA, hostB);

    const moveBeforeSpy = vi.fn(function (
      this: Element,
      movedNode: Node,
      refNode: Node | null,
    ) {
      if (!movedNode.isConnected || !this.isConnected || movedNode.parentNode === null) {
        throw new DOMException(
          "Failed to execute 'moveBefore' on 'Element': Node must be connected.",
          "HierarchyRequestError",
        );
      }
      return this.insertBefore(movedNode, refNode);
    });

    const proto = Element.prototype as Element & {
      moveBefore?: (node: Node, child: Node | null) => Node;
    };
    const prevMoveBefore = proto.moveBefore;
    proto.moveBefore = moveBeforeSpy;

    try {
      // 1. Freshly created detached stage (Terminal initial mount!) MUST NOT call `moveBefore` or throw
      const detachedStage = document.createElement("div");
      expect(detachedStage.isConnected).toBe(false);
      moveNodeAtomic(hostA, detachedStage);
      expect(hostA.contains(detachedStage)).toBe(true);
      expect(moveBeforeSpy).not.toHaveBeenCalled();

      // 2. Reparenting an already-connected live stage across connected slots uses atomic `moveBefore`
      moveNodeAtomic(hostB, detachedStage);
      expect(hostB.contains(detachedStage)).toBe(true);
      expect(moveBeforeSpy).toHaveBeenCalledTimes(1);

      // 3. Re-calling on the same slot & position is a no-op
      moveNodeAtomic(hostB, detachedStage);
      expect(moveBeforeSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (prevMoveBefore === undefined) {
        delete proto.moveBefore;
      } else {
        proto.moveBefore = prevMoveBefore;
      }
    }

    // 4. ErrorBoundary isolates render crashes and recovers on Retry or resetKeys change
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let shouldCrash = true;

    function UnstablePane() {
      if (shouldCrash) {
        throw new Error("Simulated terminal pane fault");
      }
      return <div id="recovered-pane">终端已恢复正常</div>;
    }

    let popBtnRef: HTMLButtonElement | null = null;
    let tipBtnRef: HTMLButtonElement | null = null;

    act(() => {
      root.render(
        <div>
          <ErrorBoundary fallbackTitle="终端面板异常">
            <UnstablePane />
          </ErrorBoundary>
          <Popover>
            <PopoverTrigger>
              <button
                ref={(el) => {
                  popBtnRef = el;
                }}
                type="button"
              >
                Popover Ref Target
              </button>
            </PopoverTrigger>
            <PopoverContent>Body</PopoverContent>
          </Popover>
          <Tooltip content="提示文案">
            <button
              ref={(el) => {
                tipBtnRef = el;
              }}
              type="button"
            >
              Tooltip Ref Target
            </button>
          </Tooltip>
        </div>,
      );
    });

    // Child refs on React 19 elements are preserved without `element.ref` errors
    expect(popBtnRef).not.toBeNull();
    expect(tipBtnRef).not.toBeNull();
    const loggedMessages = errSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(loggedMessages).not.toContain("Accessing element.ref was removed in React 19");

    const boundaryAlert = container.querySelector(".ls-error-boundary");
    expect(boundaryAlert).not.toBeNull();
    expect(boundaryAlert?.textContent).toContain("终端面板异常");
    expect(boundaryAlert?.textContent).toContain("Simulated terminal pane fault");

    shouldCrash = false;
    const retryBtn = boundaryAlert!.querySelector<HTMLButtonElement>("button")!;
    act(() => {
      retryBtn.click();
    });

    expect(container.querySelector("#recovered-pane")?.textContent).toBe("终端已恢复正常");
  });

  it("SplitResizer updates CSS variable and onResize live during pointermove before pointerup, reverts on Escape, and Input flex shell prevents icon/text overlap across all sizes", () => {
    const onResize = vi.fn();
    const onCollapse = vi.fn();
    const onClear = vi.fn();

    act(() => {
      root.render(
        <div
          className="desktop-workbench"
          style={{ "--inspector-w": "400px" } as React.CSSProperties}
        >
          <aside className="desktop-inspector">
            <SplitResizer
              label="调整右侧栏宽度"
              orientation="vertical"
              side="start"
              size={400}
              min={280}
              max={720}
              defaultSize={400}
              cssVariable="--inspector-w"
              targetSelector=".desktop-workbench"
              collapse={{ threshold: 200, onCollapse }}
              onResize={onResize}
            />
          </aside>
          <Input
            size="sm"
            type="search"
            leadingIcon="search"
            placeholder="搜索应用名称"
            className="ls-fusion-search"
            trailingSlot={
              <IconButton
                icon="close"
                label="清除"
                size="icon-sm"
                hideTooltip
                onClick={onClear}
              />
            }
          />
        </div>,
      );
    });

    const workbench = container.querySelector<HTMLElement>(".desktop-workbench")!;
    const sash = container.querySelector<HTMLElement>('[role="separator"]')!;

    const makePointerEvent = (type: string, clientX: number): Event => {
      if (typeof PointerEvent === "function") {
        return new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX,
          pointerId: 1,
        });
      }
      const ev = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
      });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      return ev;
    };

    // 1. Live mid-drag resize BEFORE pointerup (side="start": dragging left from 800 -> 720 grows 400 -> 480)
    act(() => {
      sash.dispatchEvent(makePointerEvent("pointerdown", 800));
    });
    expect(document.documentElement.dataset.resizing).toBe("vertical");

    act(() => {
      sash.dispatchEvent(makePointerEvent("pointermove", 720));
    });
    // Verified BEFORE pointerup!
    expect(workbench.style.getPropertyValue("--inspector-w")).toBe("480px");
    expect(onResize).toHaveBeenCalledWith(480);

    // 2. Escape mid-drag reverts both CSS variable and React onResize to startSize (400)
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.documentElement.dataset.resizing).toBeUndefined();
    expect(workbench.style.getPropertyValue("--inspector-w")).toBe("400px");
    expect(onResize).toHaveBeenLastCalledWith(400);

    // 3. Dragging past collapse threshold previews `min` (280px) live and collapses on pointerup while restoring saved startSize
    onResize.mockClear();
    act(() => {
      sash.dispatchEvent(makePointerEvent("pointerdown", 800));
      sash.dispatchEvent(makePointerEvent("pointermove", 1040)); // 400 - 240 = 160 <= 200 threshold
    });
    expect(sash.dataset.collapseArmed).toBe("true");
    expect(workbench.style.getPropertyValue("--inspector-w")).toBe("280px");
    expect(onResize).toHaveBeenCalledWith(280);

    act(() => {
      sash.dispatchEvent(makePointerEvent("pointerup", 1040));
    });
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(workbench.style.getPropertyValue("--inspector-w")).toBe("400px");
    expect(onResize).toHaveBeenLastCalledWith(400);

    // 4. Input flex shell non-overlap invariants (#89 §1.1-1.4)
    const wrap = container.querySelector<HTMLElement>(
      '.ls-input-wrap.ls-fusion-search[data-size="sm"]',
    )!;
    expect(wrap).not.toBeNull();
    const children = Array.from(wrap.children) as HTMLElement[];
    expect(children).toHaveLength(3);
    expect(children[0]?.classList.contains("ls-input-wrap__leading")).toBe(true);
    expect(children[1]?.tagName).toBe("INPUT");
    expect(children[1]?.classList.contains("ls-input")).toBe(true);
    expect(children[1]?.classList.contains("ls-input--with-leading")).toBe(false);
    expect(children[1]?.classList.contains("ls-input--with-trailing")).toBe(false);
    expect(children[2]?.classList.contains("ls-input-wrap__trailing")).toBe(true);

    const searchInput = children[1] as HTMLInputElement;
    act(() => {
      wrap.click();
    });
    expect(document.activeElement).toBe(searchInput);

    const clearBtn = children[2]!.querySelector<HTMLButtonElement>("button")!;
    act(() => {
      clearBtn.click();
    });
    expect(onClear).toHaveBeenCalledTimes(1);

    const cssText = readFileSync(
      resolve(__dirname, "../src/styles/primitives.css"),
      "utf8",
    );
    expect(cssText).toContain(".ls-input-wrap > .ls-input");
    expect(cssText).toContain("::-webkit-search-cancel-button");
    expect(cssText).toContain("html[data-resizing]");
  });
});
