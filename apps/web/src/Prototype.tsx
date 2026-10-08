import { Choice } from "./components/Choice";
import { Modal as SharedModal } from "./live/common";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  deployment,
  initialGateway,
  officialGateway,
  validateGateway,
  type Source,
} from "./config";
import {
  fileNames,
  initialTasks,
  statusLabels,
  type Status,
  type Task,
} from "./data";
import { Icon } from "./icons";
import { agentMarks } from "../../client/src/theme/agent-marks";
import appMark from "../../client/assets/mark.png";

type Scenario = "online" | "offline" | "expired" | "subscription";
type Message = { role: "user" | "assistant"; text: string };
type Dialog = "connect" | "new" | null;

function Badge({ status }: { status: Status }) {
  return (
    <span className={`badge ${status}`}>
      <span className="status-dot" />
      {statusLabels[status]}
    </span>
  );
}

function AgentMark({ agent }: { agent: Task["agent"] }) {
  const mark = agentMarks[agent.toLowerCase()];
  return (
    <span
      className={`agent-mark ${agent.toLowerCase()} ${mark.full ? "full-mark" : ""}`}
    >
      <img
        src={`data:image/svg+xml,${encodeURIComponent(mark.svg)}`}
        alt={agent}
      />
    </span>
  );
}

function Modal({
  title,
  subtitle,
  children,
  close,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => void;
}) {
  return (
    <SharedModal title={title} close={close}>
      {subtitle && <p className="muted modal-subtitle">{subtitle}</p>}
      {children}
    </SharedModal>
  );
}

function ConnectDialog({
  source,
  gateway,
  onConnect,
  close,
}: {
  source: Source;
  gateway: string;
  onConnect: (source: Source, gateway: string) => void;
  close: () => void;
}) {
  const [choice, setChoice] = useState<Source>(source);
  const [address, setAddress] = useState(
    source === "self-hosted" ? gateway : "",
  );
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (choice === "official") return onConnect(choice, officialGateway);
    try {
      const normalized = validateGateway(address);
      if (normalized === officialGateway)
        throw new Error(
          "这是官方网关，请选择官方服务；私有部署请填写自己的网关地址",
        );
      if (!/^\d{6}$/.test(code))
        throw new Error("请输入 6 位配对码；原型中可填写任意 6 位数字");
      onConnect(choice, normalized);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "请检查网关设置");
    }
  }
  return (
    <Modal
      title="连接你的电脑"
      subtitle="选择连接方式，工作台始终属于你。"
      close={close}
    >
      {deployment === "official" ? (
        <div className="source-options">
          <button
            className={
              choice === "official" ? "source-option selected" : "source-option"
            }
            onClick={() => {
              setChoice("official");
              setError("");
            }}
            aria-pressed={choice === "official"}
          >
            <Icon name="globe" size={23} />
            <strong>官方服务</strong>
            <span>登录账号，发现你的电脑</span>
            <span className="selection-dot" />
          </button>
          <button
            className={
              choice === "self-hosted"
                ? "source-option selected"
                : "source-option"
            }
            onClick={() => {
              setChoice("self-hosted");
              setError("");
            }}
            aria-pressed={choice === "self-hosted"}
          >
            <Icon name="server" size={23} />
            <strong>自托管网关</strong>
            <span>使用自己的服务器与配对码</span>
            <span className="selection-dot" />
          </button>
        </div>
      ) : (
        <div className="private-note">
          <Icon name="server" />
          <div>
            <strong>私有部署</strong>
            <p>此站点使用你配置的网关，无需 iTool 账号或官方订阅。</p>
          </div>
        </div>
      )}
      <form onSubmit={submit}>
        {choice === "official" ? (
          <div className="official-entry">
            <div className="entry-symbol">
              <Icon name="computer" size={32} />
            </div>
            <h3>你的电脑，登录后就在这里</h3>
            <p>
              电脑端运行 <code>linkshell login</code>，网页使用同一 iTool
              账号。电脑接入官方网关需要有效的 Pro 订阅。
            </p>
            <div className="endpoint">
              <span className="status-dot" />
              gateway.itool.tech <span>官方网关</span>
            </div>
          </div>
        ) : (
          <div className="pairing-form">
            <label htmlFor="gateway">网关地址</label>
            <input
              id="gateway"
              placeholder="wss://gateway.example.com"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setError("");
              }}
              autoComplete="off"
              spellCheck={false}
              required
            />
            <p className="field-hint">
              填写部署网关的地址，不是当前网页的地址。
            </p>
            <label htmlFor="pairing-code">电脑上的配对码</label>
            <input
              id="pairing-code"
              className="code-input"
              inputMode="numeric"
              placeholder="000000"
              maxLength={6}
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, ""));
                setError("");
              }}
              required
            />
            <p className="field-hint">
              电脑连接该网关后运行 <code>linkshell pair</code> 获取。真实配对码
              10 分钟内有效。
            </p>
            <div className="private-note">
              <Icon name="shield" />
              <span>
                无需官方账号与订阅。正式版仅与指定网关交换配对信息，不向它发送
                iTool 登录凭证。
              </span>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button className="button primary full" type="submit">
          {choice === "official"
            ? "预览账号登录后的工作台"
            : "预览配对后的工作台"}
          <Icon name="arrow" />
        </button>
        <p className="prototype-note">
          交互原型 · 不发起真实登录、配对或网络连接
        </p>
      </form>
    </Modal>
  );
}

function NewTaskDialog({
  close,
  create,
}: {
  close: () => void;
  create: (title: string, project: string, agent: Task["agent"]) => void;
}) {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("linkshell");
  const [agent, setAgent] = useState<Task["agent"]>("Claude");
  return (
    <Modal
      title="开始一个新任务"
      subtitle="告诉 Agent 你想完成什么。"
      close={close}
    >
      <form
        className="new-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) create(title.trim(), project, agent);
        }}
      >
        <label htmlFor="task-prompt">任务描述</label>
        <textarea
          id="task-prompt"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：帮我检查这个项目的登录流程…"
          required
          rows={4}
        />
        <div className="form-columns">
          <label>
            项目
            <Choice
              label="项目"
              value={project}
              onValueChange={setProject}
              options={[
                { value: "linkshell", label: "linkshell" },
                { value: "itool", label: "itool" },
              ]}
            />
          </label>
          <label>
            Agent
            <Choice
              label="Agent"
              value={agent}
              onValueChange={(value) => setAgent(value as Task["agent"])}
              options={[
                { value: "Claude", label: "Claude" },
                { value: "Codex", label: "Codex" },
              ]}
            />
          </label>
        </div>
        <div className="computer-inline">
          <Icon name="computer" />
          <span>Studio Mac</span>
          <span className="online-dot" />
          演示电脑
        </div>
        <button className="button primary full" disabled={!title.trim()}>
          创建演示任务
          <Icon name="arrow" />
        </button>
        <p className="prototype-note">任务仅保存在本页，不会启动真实 Agent</p>
      </form>
    </Modal>
  );
}

export function Prototype() {
  const [source, setSource] = useState<Source>(deployment);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [gateway, setGateway] = useState(initialGateway);
  const [tasks, setTasks] = useState(initialTasks);
  const [view, setView] = useState("home");
  const [project, setProject] = useState<string | null>(null);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<Dialog>(
    deployment === "self-hosted" ? "connect" : null,
  );
  const [scenario, setScenario] = useState<Scenario>("online");
  const [panel, setPanel] = useState<"files" | "changes" | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [attachments, setAttachments] = useState<Record<string, string[]>>({});
  const [toast, setToast] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [openTool, setOpenTool] = useState(false);
  const [file, setFile] = useState(fileNames[0]);
  const searchRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const task = tasks.find((item) => item.id === view);
  const available = scenario === "online";
  const selectedMessages = messages[view] ?? [];
  const selectedAttachments = attachments[view] ?? [];
  const waiting = tasks.filter((item) => item.status === "waiting");
  const filteredTasks = tasks.filter(
    (item) =>
      (!project || item.project === project) &&
      (filter === "all" || item.status === filter) &&
      `${item.title} ${item.project} ${item.agent}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "k" &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        setView("home");
        setMobileNav(false);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    conversationRef.current?.scrollTo({
      top: conversationRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [view, selectedMessages.length]);

  function navigate(next: string) {
    setView(next);
    setMobileNav(false);
    setOpenTool(false);
  }
  function updateTask(id: string, status: Status, detail: string) {
    setTasks((previous) =>
      previous.map((item) =>
        item.id === id ? { ...item, status, detail, time: "刚刚" } : item,
      ),
    );
  }
  function addMessage(id: string, message: Message) {
    setMessages((previous) => ({
      ...previous,
      [id]: [...(previous[id] ?? []), message],
    }));
  }
  function respond(id: string, allow: boolean) {
    if (!available) return;
    updateTask(
      id,
      allow ? "running" : "done",
      allow ? "已允许测试 · 演示运行中" : "已拒绝本次测试 · 等待新指令",
    );
    addMessage(id, {
      role: "assistant",
      text: allow
        ? "已记录允许执行。在正式连接中，这一步会交给电脑上的 Agent 继续处理。"
        : "已记录拒绝执行。你可以补充要求，让 Agent 调整下一步计划。",
    });
    setToast(allow ? "演示审批已通过" : "演示审批已拒绝");
  }
  function send() {
    if (
      !task ||
      !available ||
      (!drafts[view]?.trim() && !selectedAttachments.length)
    )
      return;
    const text = [
      drafts[view]?.trim(),
      ...selectedAttachments.map((name) => `附件：${name}（未上传）`),
    ]
      .filter(Boolean)
      .join("\n");
    addMessage(view, { role: "user", text });
    addMessage(view, {
      role: "assistant",
      text: "消息已添加到本地演示会话。接入真实 Host 后，这里会显示 Agent 的实时回复。",
    });
    setDrafts((previous) => ({ ...previous, [view]: "" }));
    setAttachments((previous) => ({ ...previous, [view]: [] }));
    inputRef.current?.focus();
  }

  return (
    <div className={`app-shell ${mobileNav ? "nav-open" : ""}`}>
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setProject(null);
            navigate("home");
          }}
        >
          <img className="brand-symbol" src={appMark} alt="" />
          LinkShell<span className="brand-web">web</span>
        </a>
        <button
          className="connection-switch"
          onClick={() => setDialog("connect")}
        >
          <span className={`source-icon ${source}`}>
            <Icon name={source === "official" ? "globe" : "server"} />
          </span>
          <span>
            <strong>
              {source === "official" ? "官方工作空间" : "自托管工作空间"}
            </strong>
            <small>
              {source === "official" ? "iTool 账号 · 演示" : "设备配对 · 演示"}
            </small>
          </span>
          <Icon name="down" size={15} />
        </button>
        <button className="button new-task" onClick={() => setDialog("new")}>
          <Icon name="plus" />
          新建任务<span className="new-task-corner">↗</span>
        </button>
        <nav aria-label="主导航">
          <button
            className={`nav-item ${view === "home" && !project ? "active" : ""}`}
            onClick={() => {
              setProject(null);
              setFilter("all");
              navigate("home");
            }}
          >
            <Icon name="grid" />
            首页<span className="nav-count">{tasks.length}</span>
          </button>
          <button
            className={`nav-item ${view === "computers" ? "active" : ""}`}
            onClick={() => navigate("computers")}
          >
            <Icon name="computer" />
            我的电脑
            <span className="online-dot" />
          </button>
        </nav>
        <div className="nav-section-label">
          项目<span>2</span>
        </div>
        {(["linkshell", "itool"] as const).map((name) => (
          <div key={name}>
            <button
              className={`nav-item project-nav ${project === name && view === "home" ? "active" : ""}`}
              onClick={() => {
                setProject(name);
                setFilter("all");
                navigate("home");
              }}
            >
              <Icon name="folder" />
              {name}
              <Icon name="down" size={13} />
            </button>
            <div className="recent-list">
              {tasks
                .filter((item) => item.project === name)
                .slice(0, 2)
                .map((item) => (
                  <button
                    key={item.id}
                    className={`recent-task ${view === item.id ? "selected" : ""}`}
                    onClick={() => navigate(item.id)}
                  >
                    <span className={`tiny-status ${item.status}`} />
                    <span>{item.title}</span>
                  </button>
                ))}
            </div>
          </div>
        ))}
        <div className="sidebar-bottom">
          <div className="host-presence">
            <span className={available ? "online-dot" : "offline-dot"} />
            <span>Studio Mac</span>
            <small>{available ? "演示在线" : "连接待恢复"}</small>
          </div>
          <button
            className="profile-button"
            onClick={() => setDialog("connect")}
          >
            <span className="avatar">
              {source === "official" ? "L" : <Icon name="server" />}
            </span>
            <span>
              <strong>
                {source === "official" ? "LinkShell 演示账号" : "本浏览器"}
              </strong>
              <small>
                {source === "official"
                  ? "官方服务 · Pro"
                  : "自托管 · 无需官方订阅"}
              </small>
            </span>
            <Icon name="settings" size={17} />
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(true)}
              aria-label="打开导航"
            >
              <Icon name="menu" />
            </button>
            <span>工作空间</span>
            <span className="breadcrumb-slash">/</span>
            <strong>
              {task
                ? task.project
                : view === "computers"
                  ? "我的电脑"
                  : (project ?? "概览")}
            </strong>
            {task && (
              <>
                <span className="breadcrumb-slash">/</span>
                <span className="breadcrumb-task">会话</span>
              </>
            )}
          </div>
          <div className="topbar-right">
            <button
              className="icon-button theme-switch"
              aria-label={theme === "light" ? "切换深色外观" : "切换浅色外观"}
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              <Icon name="moon" />
            </button>
            <span className="demo-tag">
              <span />
              交互原型
            </span>
            <Choice
              label="预览连接状态"
              value={scenario}
              onValueChange={(value) => setScenario(value as Scenario)}
              options={[
                { value: "online", label: "正常连接" },
                { value: "offline", label: "网络中断" },
                {
                  value: "expired",
                  label: source === "official" ? "登录失效" : "配对失效",
                },
                ...(source === "official"
                  ? [{ value: "subscription", label: "Pro 到期" }]
                  : []),
              ]}
            />
            <button
              className="icon-button"
              aria-label="连接设置"
              onClick={() => setDialog("connect")}
            >
              <Icon name="settings" />
            </button>
          </div>
        </header>
        {scenario !== "online" && (
          <div className={`connection-banner ${scenario}`} role="status">
            <Icon name={scenario === "offline" ? "globe" : "shield"} />
            <span>
              {scenario === "offline"
                ? "连接暂时中断，草稿已保留。正式版恢复连接后会自动补齐会话。"
                : scenario === "subscription"
                  ? "演示：电脑的 Pro 订阅已到期，重新接入官方网关需要续订；已有记录仍可查看。"
                  : source === "official"
                    ? "演示：登录凭证已失效，需要重新登录。"
                    : "演示：此浏览器的配对已被撤销，需要重新配对。"}
            </span>
            <button
              onClick={() =>
                scenario === "offline"
                  ? (setScenario("online"), setToast("已恢复演示连接"))
                  : setDialog("connect")
              }
            >
              {scenario === "offline" ? "模拟恢复" : "查看连接设置"}
            </button>
          </div>
        )}

        {!task && view !== "computers" && (
          <div className="overview page-enter">
            <div className="page-heading">
              <div>
                <h1>{project ?? "首页"}</h1>
                <p className="host-summary">
                  <span className={available ? "online-dot" : "offline-dot"} />
                  Studio Mac
                  {waiting.length > 0 && (
                    <span className="waiting-copy">
                      · {waiting.length} 项需要你
                    </span>
                  )}
                </p>
              </div>
              <button
                className="button primary"
                onClick={() => setDialog("new")}
              >
                <Icon name="plus" />
                新建任务
              </button>
            </div>
            <div className="home-controls">
              <label className="search-box">
                <Icon name="search" size={18} />
                <input
                  ref={searchRef}
                  aria-label="搜索任务"
                  placeholder="搜索会话、项目或 Agent"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <kbd>⌘ K</kbd>
              </label>
              <div className="filters" role="group" aria-label="任务状态筛选">
                {(["all", "running", "waiting", "done"] as const).map(
                  (status) => (
                    <button
                      key={status}
                      aria-pressed={filter === status}
                      className={filter === status ? "selected" : ""}
                      onClick={() => setFilter(status)}
                    >
                      {status === "all" ? "全部" : statusLabels[status]}
                    </button>
                  ),
                )}
              </div>
            </div>
            {(["waiting", "running", "done"] as const).map((status) => {
              const group = filteredTasks.filter(
                (item) => item.status === status,
              );
              if (!group.length) return null;
              return (
                <section className="session-group" key={status}>
                  <div
                    className={`section-heading ${status === "waiting" ? "waiting-heading" : ""}`}
                  >
                    <h2>
                      {status === "done" ? "今天" : statusLabels[status]}
                      <span>{group.length}</span>
                    </h2>
                    {status === "running" && (
                      <span className="section-note">Agent 正在电脑上工作</span>
                    )}
                  </div>
                  {status === "waiting" ? (
                    group.map((item) => (
                      <article className="attention-card" key={item.id}>
                        <button
                          className="attention-title"
                          onClick={() => navigate(item.id)}
                        >
                          <AgentMark agent={item.agent} />
                          <span>
                            <strong>{item.title}</strong>
                            <small>
                              {item.project} · {item.agent}
                            </small>
                          </span>
                          <time>{item.time}</time>
                          <Icon name="chevron" size={16} />
                        </button>
                        <div className="permission-preview">
                          <div>
                            <Icon name="shield" size={17} />
                            <strong>需要你的确认</strong>
                          </div>
                          <code>pnpm --filter @linkshell/client-core test</code>
                        </div>
                        <div className="attention-actions">
                          <button
                            className="text-button"
                            onClick={() => navigate(item.id)}
                          >
                            查看会话
                            <Icon name="chevron" size={13} />
                          </button>
                          <button
                            className="button secondary"
                            disabled={!available}
                            onClick={() => respond(item.id, false)}
                          >
                            拒绝
                          </button>
                          <button
                            className="button primary"
                            disabled={!available}
                            onClick={() => respond(item.id, true)}
                          >
                            允许本次
                          </button>
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="task-list">
                      {group.map((item) => (
                        <button
                          className="task-row"
                          key={item.id}
                          onClick={() => navigate(item.id)}
                        >
                          <span className="row-avatar">
                            <AgentMark agent={item.agent} />
                            <span className={`tiny-status ${item.status}`} />
                          </span>
                          <span className="task-info">
                            <strong>{item.title}</strong>
                            <span>
                              <span className="project-label">
                                {item.project}
                              </span>
                              <span className="separator">·</span>
                              <span
                                className={
                                  item.status === "running"
                                    ? "running-copy"
                                    : ""
                                }
                              >
                                {item.detail}
                              </span>
                            </span>
                          </span>
                          <span className="task-meta">
                            <small>{item.time}</small>
                            <span>{item.agent}</span>
                          </span>
                          <Icon name="chevron" size={14} />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
            {!filteredTasks.length && (
              <div className="empty-state">
                <Icon name="search" size={28} />
                <h3>没有找到会话</h3>
                <p>试试其他关键词或筛选条件。</p>
                <button
                  className="text-button"
                  onClick={() => {
                    setFilter("all");
                    setSearch("");
                  }}
                >
                  清除筛选
                </button>
              </div>
            )}
            <footer className="page-footer">
              <Icon name="shield" size={13} />
              <span>
                {source === "official"
                  ? "官方网关 · 账号连接"
                  : "自托管网关 · 设备配对"}
              </span>
              <span>演示数据</span>
            </footer>
          </div>
        )}

        {view === "computers" && (
          <div className="overview page-enter">
            <div className="page-heading">
              <div>
                <h1>我的电脑</h1>
                <p className="muted">管理你的电脑与连接方式。</p>
              </div>
              <button
                className="button primary"
                onClick={() => setDialog("connect")}
              >
                <Icon name="plus" />
                连接电脑
              </button>
            </div>
            <div className="connection-detail-card">
              <span className="large-source-icon">
                <Icon
                  name={source === "official" ? "globe" : "server"}
                  size={28}
                />
              </span>
              <div>
                <span className="eyebrow">
                  {source === "official"
                    ? "OFFICIAL GATEWAY"
                    : "SELF-HOSTED GATEWAY"}
                </span>
                <h2>
                  {source === "official"
                    ? "LinkShell 官方服务"
                    : "你自己的网关"}
                </h2>
                <code>{gateway || "尚未设置网关"}</code>
                <p className="muted">
                  {source === "official"
                    ? "通过同一 iTool 账号发现电脑。电脑接入需要有效的 Pro 订阅。"
                    : "通过设备配对授权，无需官方账号或订阅。网关与数据由你管理。"}
                </p>
              </div>
              <button
                className="button secondary"
                onClick={() => setDialog("connect")}
              >
                连接设置
              </button>
            </div>
            <div className="computer-table">
              <div>
                <Icon name="computer" size={28} />
                <span>
                  <strong>Studio Mac</strong>
                  <small>macOS · 演示电脑</small>
                </span>
                <span className={`badge ${available ? "running" : "waiting"}`}>
                  <span className="status-dot" />
                  {available ? "在线" : "待恢复"}
                </span>
                <span className="muted">
                  {source === "official" ? "账号关联" : "已配对（演示）"}
                </span>
                <button
                  className="button secondary"
                  onClick={() => {
                    setProject(null);
                    navigate("home");
                  }}
                >
                  查看任务
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            </div>
            <div className="deployment-note">
              <Icon name="shield" />
              <div>
                <strong>网页部署位置与网关地址是两个独立设置</strong>
                <p>
                  官方网页可以连接自托管网关。私有部署默认只显示配对入口，并从公开配置读取网关地址；不依赖官方登录服务。正式版不会把官方账号凭证发送给自定义网关。
                </p>
              </div>
            </div>
          </div>
        )}

        {task && (
          <div className="session-page page-enter">
            <div className="session-heading">
              <div>
                <div className="session-title">
                  <h1>{task.title}</h1>
                  <Badge status={task.status} />
                </div>
                <div className="session-subtitle">
                  <AgentMark agent={task.agent} />
                  <span>{task.agent}</span>
                  <span className="separator">/</span>
                  <Icon name="computer" size={13} />
                  <span>Studio Mac</span>
                  <span className="separator">/</span>
                  <Icon name="branch" size={13} />
                  <span>codex/session-recovery</span>
                </div>
              </div>
              <div className="session-actions">
                <button
                  className={`icon-button ${terminal ? "pressed" : ""}`}
                  aria-label="切换终端"
                  aria-pressed={terminal}
                  onClick={() => setTerminal(!terminal)}
                >
                  <Icon name="terminal" />
                </button>
                <button
                  className={`icon-button ${panel ? "pressed" : ""}`}
                  aria-label="切换文件面板"
                  aria-pressed={!!panel}
                  onClick={() => setPanel(panel ? null : "changes")}
                >
                  <Icon name="panel" />
                </button>
              </div>
            </div>
            <div className={`session-layout ${panel ? "with-panel" : ""}`}>
              <div className="conversation-column">
                <div className="conversation" ref={conversationRef}>
                  <div className="date-divider">
                    <span>今天 · 演示会话</span>
                  </div>
                  <div className="user-message">
                    <span className="message-label">
                      你 <small>14:28</small>
                    </span>
                    <p>
                      {task.id === "auth"
                        ? "帮我完善登录续期和断线恢复。希望登录一次之后能长期使用，临时网络失败也不要丢掉登录状态。"
                        : task.title}
                    </p>
                  </div>
                  <div className="assistant-message">
                    <div className="message-author">
                      <AgentMark agent={task.agent} />
                      <strong>{task.agent}</strong>
                      <span>14:29</span>
                    </div>
                    {task.id === "auth" ? (
                      <>
                        <p>
                          {task.id === "auth"
                            ? "我检查了当前的连接流程。问题出在刷新失败之后：临时网络错误被当成未登录处理，导致账号下的电脑暂时不可见。"
                            : "我会先梳理相关实现，确定改动范围，再逐步完成并验证。以下内容用于展示网页端的工具调用和文件变更布局。"}
                        </p>
                        <p>这次会把登录状态和连接状态分开处理：</p>
                        <ol className="plan-list">
                          <li>保留本地凭证，区分网络错误与凭证失效。</li>
                          <li>恢复连接时自动续期，重新订阅会话。</li>
                          <li>补齐断线期间的事件，避免消息重复。</li>
                        </ol>
                        <button
                          className="tool-call"
                          onClick={() => setOpenTool(!openTool)}
                          aria-expanded={openTool}
                        >
                          <span className="tool-check">
                            <Icon name="check" size={14} />
                          </span>
                          <span>已检查连接与会话逻辑</span>
                          <small>3 个文件</small>
                          <Icon
                            name={openTool ? "down" : "chevron"}
                            size={14}
                          />
                        </button>
                        {openTool && (
                          <div className="tool-output">
                            <code>
                              read src/auth/session.ts
                              <br />
                              read src/connection/retry.ts
                              <br />
                              read test/session.test.ts
                            </code>
                            <p>演示工具记录，未读取或修改真实文件。</p>
                          </div>
                        )}
                        <div className="change-summary">
                          <Icon name="file" size={16} />
                          <button onClick={() => setPanel("changes")}>
                            查看 3 个文件变更
                          </button>
                          <span className="added">+42</span>
                          <span className="removed">−12</span>
                        </div>
                        <p>改动已整理好，接下来需要执行测试来验证恢复流程。</p>
                        {task.status === "waiting" && (
                          <div className="approval-card">
                            <div className="approval-heading">
                              <span className="approval-icon">
                                <Icon name="shield" size={19} />
                              </span>
                              <div>
                                <strong>允许执行这条命令吗？</strong>
                                <span>
                                  将在 Studio Mac 的 linkshell 项目中执行
                                </span>
                              </div>
                              <span className="badge waiting">等待确认</span>
                            </div>
                            <pre>pnpm --filter @linkshell/client-core test</pre>
                            <div className="approval-footer">
                              <span>仅允许本次操作</span>
                              <button
                                className="button secondary"
                                onClick={() => respond(task.id, false)}
                                disabled={!available}
                              >
                                拒绝
                              </button>
                              <button
                                className="button primary"
                                onClick={() => respond(task.id, true)}
                                disabled={!available}
                              >
                                <Icon name="check" size={15} />
                                允许执行
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <p>
                        这是一个本地演示会话。你可以在下方补充消息、切换文件面板或展开终端，体验工作区布局。接入
                        Host 后，这里会显示 {task.agent} 的真实执行过程。
                      </p>
                    )}
                  </div>
                  {selectedMessages.map((message, index) => (
                    <div
                      key={`${view}-${index}`}
                      className={
                        message.role === "user"
                          ? "user-message"
                          : "assistant-message reply"
                      }
                    >
                      <span className="message-label">
                        {message.role === "user" ? "你" : task.agent}
                        <small>刚刚 · 本地演示</small>
                      </span>
                      <p>{message.text}</p>
                    </div>
                  ))}
                </div>
                {terminal && (
                  <section className="terminal-panel" aria-label="演示终端">
                    <div className="terminal-heading">
                      <span>
                        <Icon name="terminal" size={14} />
                        终端
                        <span className="terminal-demo">
                          只演示 · 不执行命令
                        </span>
                      </span>
                      <button
                        className="icon-button"
                        aria-label="关闭终端"
                        onClick={() => setTerminal(false)}
                      >
                        <Icon name="close" size={15} />
                      </button>
                    </div>
                    <div className="terminal-output">
                      <p>
                        <span className="terminal-green">
                          ~/projects/{task.project}
                        </span>{" "}
                        on{" "}
                        <span className="terminal-blue">
                          codex/session-recovery
                        </span>
                      </p>
                      {terminalLines.map((line, index) => (
                        <p key={index}>{line}</p>
                      ))}
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!terminalInput.trim()) return;
                          setTerminalLines([
                            ...terminalLines,
                            `❯ ${terminalInput}`,
                            "原型不执行命令。正式版将连接电脑上的 PTY 终端。",
                          ]);
                          setTerminalInput("");
                        }}
                      >
                        <span>❯</span>
                        <input
                          aria-label="演示终端命令"
                          value={terminalInput}
                          onChange={(event) =>
                            setTerminalInput(event.target.value)
                          }
                          spellCheck={false}
                          placeholder="试着输入一条命令"
                        />
                      </form>
                    </div>
                  </section>
                )}
                <div className="composer-wrap">
                  <div className="composer">
                    {selectedAttachments.length > 0 && (
                      <div className="attachment-list">
                        {selectedAttachments.map((name, index) => (
                          <span key={`${name}-${index}`}>
                            <Icon name="file" size={13} />
                            {name}
                            <button
                              aria-label={`移除附件 ${name}`}
                              onClick={() =>
                                setAttachments((previous) => ({
                                  ...previous,
                                  [view]: selectedAttachments.filter(
                                    (_, at) => at !== index,
                                  ),
                                }))
                              }
                            >
                              <Icon name="close" size={12} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <textarea
                      ref={inputRef}
                      aria-label="发送消息"
                      value={drafts[view] ?? ""}
                      onChange={(event) =>
                        setDrafts((previous) => ({
                          ...previous,
                          [view]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          send();
                        }
                      }}
                      placeholder={
                        available
                          ? "补充你的想法，或告诉 Agent 下一步做什么…"
                          : "连接中断也可以继续写，草稿会保留…"
                      }
                      rows={2}
                    />
                    <div className="composer-toolbar">
                      <div>
                        <input
                          ref={uploadRef}
                          type="file"
                          multiple
                          hidden
                          onChange={(event) => {
                            const names = Array.from(
                              event.target.files ?? [],
                            ).map((item) => item.name);
                            setAttachments((previous) => ({
                              ...previous,
                              [view]: [...(previous[view] ?? []), ...names],
                            }));
                            event.target.value = "";
                          }}
                        />
                        <button
                          className="icon-button"
                          aria-label="添加演示附件"
                          onClick={() => uploadRef.current?.click()}
                        >
                          <Icon name="attach" size={17} />
                        </button>
                        <span className="composer-agent">
                          {task.agent}
                          <span className="separator">·</span>默认模型
                        </span>
                      </div>
                      <div>
                        {task.status === "running" && (
                          <button
                            className="icon-button"
                            aria-label="停止演示任务"
                            disabled={!available}
                            onClick={() => {
                              updateTask(task.id, "done", "已停止 · 演示任务");
                              setToast("已停止演示任务");
                            }}
                          >
                            <Icon name="stop" size={16} />
                          </button>
                        )}
                        <button
                          className="send-button"
                          aria-label="发送演示消息"
                          disabled={
                            !available ||
                            (!drafts[view]?.trim() &&
                              !selectedAttachments.length)
                          }
                          onClick={send}
                        >
                          <Icon name="send" size={19} />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="composer-caption">
                    <span>Enter 发送 · Shift Enter 换行</span>
                    <span>演示消息不会发送到电脑</span>
                  </div>
                </div>
              </div>
              {panel && (
                <aside className="file-panel">
                  <div className="panel-tabs">
                    <button
                      className={panel === "changes" ? "selected" : ""}
                      onClick={() => setPanel("changes")}
                    >
                      变更<span>3</span>
                    </button>
                    <button
                      className={panel === "files" ? "selected" : ""}
                      onClick={() => setPanel("files")}
                    >
                      文件
                    </button>
                    <button
                      className="icon-button"
                      aria-label="关闭文件面板"
                      onClick={() => setPanel(null)}
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </div>
                  <div className="panel-project">
                    <Icon name="folder" size={15} />
                    {task.project}
                    <span>示例文件</span>
                  </div>
                  <div className="file-list">
                    {fileNames.map((name, index) => (
                      <button
                        key={name}
                        className={file === name ? "selected" : ""}
                        onClick={() => setFile(name)}
                      >
                        <Icon name="file" size={14} />
                        <span>{name}</span>
                        {panel === "changes" && (
                          <small className="added">+{[18, 16, 8][index]}</small>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="diff-heading">
                    <span>{file.split("/").pop()}</span>
                    <span>{panel === "changes" ? "+18 −4" : "TypeScript"}</span>
                  </div>
                  <div className="code-preview">
                    <div>
                      <span>01</span>
                      <code>
                        {file.includes("test")
                          ? "it('retains the session', () => {"
                          : "async function reconnect() {"}
                      </code>
                    </div>
                    <div>
                      <span>02</span>
                      <code> const session = loadSession();</code>
                    </div>
                    {panel === "changes" && (
                      <div className="diff-remove">
                        <span>−</span>
                        <code> if (!token) signOut();</code>
                      </div>
                    )}
                    <div className={panel === "changes" ? "diff-add" : ""}>
                      <span>03</span>
                      <code> if (!session) return;</code>
                    </div>
                    <div className={panel === "changes" ? "diff-add" : ""}>
                      <span>04</span>
                      <code>{"  try {"}</code>
                    </div>
                    <div className={panel === "changes" ? "diff-add" : ""}>
                      <span>05</span>
                      <code> await refreshSession();</code>
                    </div>
                    <div className={panel === "changes" ? "diff-add" : ""}>
                      <span>06</span>
                      <code> await resumeConnection();</code>
                    </div>
                    <div className={panel === "changes" ? "diff-add" : ""}>
                      <span>07</span>
                      <code>{"  } catch (error) {"}</code>
                    </div>
                    <div className={panel === "changes" ? "diff-add" : ""}>
                      <span>08</span>
                      <code> scheduleRetry(error);</code>
                    </div>
                    <div>
                      <span>09</span>
                      <code>{"  }"}</code>
                    </div>
                    <div>
                      <span>10</span>
                      <code>{"}"}</code>
                    </div>
                  </div>
                  <div className="panel-bottom">
                    <Icon name="branch" size={14} />
                    <span>codex/session-recovery</span>
                    <span className="added">+42</span>
                    <span className="removed">−12</span>
                  </div>
                </aside>
              )}
            </div>
          </div>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          {toast}
        </div>
      )}
      {dialog === "connect" && (
        <ConnectDialog
          source={source}
          gateway={gateway}
          close={() => setDialog(null)}
          onConnect={(nextSource, nextGateway) => {
            setSource(nextSource);
            setGateway(nextGateway);
            setScenario("online");
            setDialog(null);
            setToast(
              nextSource === "official"
                ? "已切换到官方服务演示"
                : "已切换到自托管演示，未发起真实配对",
            );
          }}
        />
      )}
      {dialog === "new" && (
        <NewTaskDialog
          close={() => setDialog(null)}
          create={(title, project, agent) => {
            const id = crypto.randomUUID();
            setTasks((previous) => [
              {
                id,
                title,
                project,
                agent,
                status: "running",
                detail: "新建演示任务",
                time: "刚刚",
              },
              ...previous,
            ]);
            setDialog(null);
            navigate(id);
            setToast("已创建本地演示任务");
          }}
        />
      )}
    </div>
  );
}
