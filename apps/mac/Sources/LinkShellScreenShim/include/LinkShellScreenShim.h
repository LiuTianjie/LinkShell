#ifndef LINKSHELL_SCREEN_SHIM_H
#define LINKSHELL_SCREEN_SHIM_H
#include <mach/mach.h>
#include <stdint.h>
#include <sys/types.h>
// Private, random bootstrap name, removed when its receive right is destroyed.
mach_port_t ls_screen_listen(const char *name);
mach_port_t ls_screen_connect(const char *name);
void ls_screen_close(mach_port_t port, int receiver);
int ls_screen_send(mach_port_t destination, mach_port_t surface, uint64_t token, const void *metadata, uint32_t size);
// Returns 1 for a frame, 0 for a rejected message, -1 when the receive right is gone.
int ls_screen_receive(mach_port_t port, pid_t child, mach_port_t *surface, uint64_t *token, void *metadata, uint32_t *size);
#endif
