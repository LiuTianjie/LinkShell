#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Locate the signed bundle even when invoked via ~/.local/bin/linkshell.
int main(int argc, char **argv) {
  char executable[PATH_MAX], resolved[PATH_MAX], node[PATH_MAX], cli[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) || !realpath(executable, resolved)) { perror("LinkShell runtime path"); return 1; }
  char *slash = strrchr(resolved, '/');
  if (!slash) return 1;
  *slash = '\0';
  if (snprintf(node, sizeof(node), "%s/node", resolved) >= sizeof(node) ||
      snprintf(cli, sizeof(cli), "%s/../Resources/runtime/cli/dist/cli/src/index.js", resolved) >= sizeof(cli)) return 1;
  char **args = calloc((size_t)argc + 2, sizeof(char *));
  if (!args) return 1;
  args[0] = node; args[1] = cli;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  execv(node, args);
  perror("LinkShell runtime"); free(args); return 1;
}
