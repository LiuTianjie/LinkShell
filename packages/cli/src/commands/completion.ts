export const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof SUPPORTED_SHELLS)[number];

const TOP_COMMANDS = [
  "setup",
  "host",
  "restart",
  "stop",
  "status",
  "logs",
  "doctor",
  "pair",
  "devices",
  "password",
  "screen",
  "gateway",
  "claude",
  "codex",
  "login",
  "logout",
  "upgrade",
  "completion",
];

const HOST_SUBCOMMANDS = [
  "status",
  "stop",
  "restart",
  "install-service",
  "uninstall-service",
  "service-status",
];

const GATEWAY_SUBCOMMANDS = [
  "status",
  "stop",
  "install-service",
  "uninstall-service",
];

const PASSWORD_SUBCOMMANDS = ["set", "remove"];
const DEVICES_SUBCOMMANDS = ["remove"];

export function generateCompletion(shell: string): string {
  const normalized = shell.trim().toLowerCase();
  if (normalized === "bash") return bashCompletion();
  if (normalized === "zsh") return zshCompletion();
  if (normalized === "fish") return fishCompletion();
  throw new Error(`Unsupported shell "${shell}". Expected one of: ${SUPPORTED_SHELLS.join(", ")}.`);
}

function bashCompletion(): string {
  return `# LinkShell bash completion — add to ~/.bashrc:
#   eval "$(linkshell completion bash)"
_linkshell_completions() {
  local cur prev cmd sub
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"
  sub="\${COMP_WORDS[2]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${TOP_COMMANDS.join(" ")} --help --version" -- "\${cur}") )
    return 0
  fi

  case "\${cmd}" in
    host)
      if [[ \${COMP_CWORD} -eq 2 && "\${cur}" != -* ]]; then
        COMPREPLY=( $(compgen -W "${HOST_SUBCOMMANDS.join(" ")}" -- "\${cur}") )
        return 0
      fi
      case "\${sub}" in
        status|service-status)
          COMPREPLY=( $(compgen -W "--json --help" -- "\${cur}") )
          ;;
        install-service)
          COMPREPLY=( $(compgen -W "--dry-run --gateway --help" -- "\${cur}") )
          ;;
        uninstall-service)
          COMPREPLY=( $(compgen -W "--dry-run --help" -- "\${cur}") )
          ;;
        *)
          COMPREPLY=( $(compgen -W "--daemon --dev-port --gateway --lan --keep-awake --help" -- "\${cur}") )
          ;;
      esac
      ;;
    gateway)
      if [[ \${COMP_CWORD} -eq 2 && "\${cur}" != -* ]]; then
        COMPREPLY=( $(compgen -W "${GATEWAY_SUBCOMMANDS.join(" ")}" -- "\${cur}") )
        return 0
      fi
      case "\${sub}" in
        status)
          COMPREPLY=( $(compgen -W "--json --port --host --help" -- "\${cur}") )
          ;;
        install-service)
          COMPREPLY=( $(compgen -W "--dry-run --port --host --help" -- "\${cur}") )
          ;;
        uninstall-service)
          COMPREPLY=( $(compgen -W "--dry-run --help" -- "\${cur}") )
          ;;
        *)
          COMPREPLY=( $(compgen -W "--port --host --daemon --help" -- "\${cur}") )
          ;;
      esac
      ;;
    logs)
      if [[ "\${prev}" == "--service" ]]; then
        COMPREPLY=( $(compgen -W "host gateway upgrade" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "-f --follow -n --lines --service --journal --help" -- "\${cur}") )
      fi
      ;;
    login)
      COMPREPLY=( $(compgen -W "--email --password-stdin --no-browser --help" -- "\${cur}") )
      ;;
    pair)
      COMPREPLY=( $(compgen -W "--no-qr --json --help" -- "\${cur}") )
      ;;
    status)
      COMPREPLY=( $(compgen -W "--json --help" -- "\${cur}") )
      ;;
    doctor)
      COMPREPLY=( $(compgen -W "--gateway --json --help" -- "\${cur}") )
      ;;
    upgrade)
      COMPREPLY=( $(compgen -W "--check --help" -- "\${cur}") )
      ;;
    screen)
      COMPREPLY=( $(compgen -W "--check --help" -- "\${cur}") )
      ;;
    devices)
      if [[ \${COMP_CWORD} -eq 2 && "\${cur}" != -* ]]; then
        COMPREPLY=( $(compgen -W "${DEVICES_SUBCOMMANDS.join(" ")}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "--json --help" -- "\${cur}") )
      fi
      ;;
    password)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${PASSWORD_SUBCOMMANDS.join(" ")}" -- "\${cur}") )
      fi
      ;;
    completion)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${SUPPORTED_SHELLS.join(" ")}" -- "\${cur}") )
      fi
      ;;
  esac
}
complete -F _linkshell_completions linkshell
`;
}

function zshCompletion(): string {
  return `#compdef linkshell
# LinkShell zsh completion — save to a directory in $fpath or add to ~/.zshrc:
#   eval "$(linkshell completion zsh)"

_linkshell() {
  local -a commands host_cmds gateway_cmds password_cmds devices_cmds shells
  commands=(
    'setup:Set this computer up (host, screen, phone)'
    'host:Run or manage the LinkShell host daemon'
    'restart:Restart the LinkShell host'
    'stop:Stop all running LinkShell processes'
    'status:Show host, gateway, and service status'
    'logs:View or follow LinkShell logs'
    'doctor:Check Node, PTY, SQLite, host, permissions, and gateway'
    'pair:Pair a phone with this computer'
    'devices:List or remove paired phones'
    'password:Manage computer access password'
    'screen:Check or configure remote screen sharing'
    'gateway:Run or manage a self-hosted gateway'
    'claude:Start Claude Code with phone handoff'
    'codex:Start Codex attached to LinkShell host'
    'login:Log in to LinkShell (supports SSH/headless)'
    'logout:Log out of LinkShell'
    'upgrade:Upgrade LinkShell CLI and running host'
    'completion:Generate shell completion scripts'
  )
  host_cmds=(
    'status:Show host status'
    'stop:Stop the host'
    'restart:Restart the host'
    'install-service:Install OS user service (systemd/launchd)'
    'uninstall-service:Uninstall OS user service'
    'service-status:Show OS user service status'
  )
  gateway_cmds=(
    'status:Check gateway status and /healthz'
    'stop:Stop the gateway'
    'install-service:Install gateway as OS user service'
    'uninstall-service:Uninstall gateway OS user service'
  )
  password_cmds=(
    'set:Set or change access password'
    'remove:Remove access password'
  )
  devices_cmds=(
    'remove:Unpair a phone'
  )
  shells=(bash zsh fish)

  if (( CURRENT == 2 )); then
    _describe -t commands 'linkshell command' commands
    return
  fi

  case "\${words[2]}" in
    host)
      if (( CURRENT == 3 )); then
        _describe -t commands 'host subcommand' host_cmds
      fi
      _arguments \
        '--daemon[Run in background]' \
        '--dev-port[Loopback dev port]:port:' \
        '--gateway[Gateway URL, off, or default]:url:' \
        '--lan[Same-Wi-Fi LAN port or off]:port:' \
        '--keep-awake[Keep-awake mode]:mode:(smart always off)' \
        '--dry-run[Preview without applying]' \
        '--json[Output JSON]'
      ;;
    gateway)
      if (( CURRENT == 3 )); then
        _describe -t commands 'gateway subcommand' gateway_cmds
      fi
      _arguments \
        '--port[Listen port]:port:' \
        '--host[Bind address]:host:' \
        '--daemon[Run in background]' \
        '--dry-run[Preview without applying]' \
        '--json[Output JSON]'
      ;;
    logs)
      _arguments \
        '(-f --follow)'{-f,--follow}'[Follow log output]' \
        '(-n --lines)'{-n,--lines}'[Number of lines to show]:lines:' \
        '--service[Service log to view]:service:(host gateway upgrade)' \
        '--journal[Read from systemd journalctl]'
      ;;
    login)
      _arguments \
        '--email[Email address for password login]:email:' \
        '--password-stdin[Read password from stdin]' \
        '--no-browser[Do not open a local browser]'
      ;;
    pair)
      _arguments '--no-qr[Suppress QR code]' '--json[Output pairing offer as JSON]'
      ;;
    status)
      _arguments '--json[Output JSON]'
      ;;
    doctor)
      _arguments '--gateway[Check gateway URL]:url:' '--json[Output JSON]'
      ;;
    upgrade)
      _arguments '--check[Check versions without modifying]'
      ;;
    screen)
      _arguments '--check[Check status only]'
      ;;
    devices)
      if (( CURRENT == 3 )); then
        _describe -t commands 'devices subcommand' devices_cmds
      fi
      _arguments '--json[Output JSON]'
      ;;
    password)
      if (( CURRENT == 3 )); then
        _describe -t commands 'password subcommand' password_cmds
      fi
      ;;
    completion)
      if (( CURRENT == 3 )); then
        _values 'shell' $shells
      fi
      ;;
  esac
}

if [[ "\${zsh_eval_context[-1]}" == "loadautofunc" ]]; then
  _linkshell "$@"
else
  compdef _linkshell linkshell
fi
`;
}

function fishCompletion(): string {
  return `# LinkShell fish completion — save to ~/.config/fish/completions/linkshell.fish:
#   linkshell completion fish > ~/.config/fish/completions/linkshell.fish

set -l top_cmds ${TOP_COMMANDS.join(" ")}
complete -c linkshell -f

complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a setup -d "Set this computer up"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a host -d "Run or manage the LinkShell host"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a restart -d "Restart the LinkShell host"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a stop -d "Stop all running LinkShell processes"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a status -d "Show host and gateway status"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a logs -d "View or follow logs"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a doctor -d "Run environment diagnostics"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a pair -d "Pair a phone"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a devices -d "List or unpair phones"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a password -d "Manage access password"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a screen -d "Configure screen sharing"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a gateway -d "Run or manage a gateway"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a claude -d "Start Claude Code with phone handoff"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a codex -d "Start Codex attached to host"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a login -d "Log in to LinkShell"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a logout -d "Log out of LinkShell"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a upgrade -d "Upgrade LinkShell CLI and host"
complete -c linkshell -n "not __fish_seen_subcommand_from $top_cmds" -a completion -d "Generate shell completions"

complete -c linkshell -n "__fish_seen_subcommand_from host; and not __fish_seen_subcommand_from ${HOST_SUBCOMMANDS.join(" ")}" -a "${HOST_SUBCOMMANDS.join(" ")}"
complete -c linkshell -n "__fish_seen_subcommand_from host" -l daemon -d "Run in background"
complete -c linkshell -n "__fish_seen_subcommand_from host" -l gateway -r -d "Gateway URL, off, or default"
complete -c linkshell -n "__fish_seen_subcommand_from host" -l lan -d "Enable same-Wi-Fi LAN mode"
complete -c linkshell -n "__fish_seen_subcommand_from host" -l keep-awake -r -a "smart always off" -d "Keep-awake mode"
complete -c linkshell -n "__fish_seen_subcommand_from host" -l dry-run -d "Preview service plan"
complete -c linkshell -n "__fish_seen_subcommand_from host" -l json -d "Output JSON"

complete -c linkshell -n "__fish_seen_subcommand_from gateway; and not __fish_seen_subcommand_from ${GATEWAY_SUBCOMMANDS.join(" ")}" -a "${GATEWAY_SUBCOMMANDS.join(" ")}"
complete -c linkshell -n "__fish_seen_subcommand_from gateway" -l port -r -d "Listen port"
complete -c linkshell -n "__fish_seen_subcommand_from gateway" -l host -r -d "Bind address"
complete -c linkshell -n "__fish_seen_subcommand_from gateway" -l daemon -d "Run in background"
complete -c linkshell -n "__fish_seen_subcommand_from gateway" -l dry-run -d "Preview service plan"
complete -c linkshell -n "__fish_seen_subcommand_from gateway" -l json -d "Output JSON"

complete -c linkshell -n "__fish_seen_subcommand_from logs" -s f -l follow -d "Follow log output"
complete -c linkshell -n "__fish_seen_subcommand_from logs" -s n -l lines -r -d "Number of lines"
complete -c linkshell -n "__fish_seen_subcommand_from logs" -l service -r -a "host gateway upgrade" -d "Target log service"
complete -c linkshell -n "__fish_seen_subcommand_from logs" -l journal -d "Read from systemd journalctl"

complete -c linkshell -n "__fish_seen_subcommand_from login" -l email -d "Email address for password login"
complete -c linkshell -n "__fish_seen_subcommand_from login" -l password-stdin -d "Read password from stdin"
complete -c linkshell -n "__fish_seen_subcommand_from login" -l no-browser -d "Do not open a local browser"

complete -c linkshell -n "__fish_seen_subcommand_from pair" -l no-qr -d "Suppress QR code"
complete -c linkshell -n "__fish_seen_subcommand_from pair" -l json -d "Output JSON"

complete -c linkshell -n "__fish_seen_subcommand_from status doctor devices" -l json -d "Output JSON"
complete -c linkshell -n "__fish_seen_subcommand_from doctor" -l gateway -r -d "Check gateway URL"
complete -c linkshell -n "__fish_seen_subcommand_from upgrade screen" -l check -d "Check only"
complete -c linkshell -n "__fish_seen_subcommand_from devices" -a "remove" -d "Unpair a phone"
complete -c linkshell -n "__fish_seen_subcommand_from password" -a "set remove"
complete -c linkshell -n "__fish_seen_subcommand_from completion" -a "${SUPPORTED_SHELLS.join(" ")}"
`;
}

export function runCompletion(shell: string, stdout: (chunk: string) => void = (c) => process.stdout.write(c)): void {
  stdout(generateCompletion(shell));
}
