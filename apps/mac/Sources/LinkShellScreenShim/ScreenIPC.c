#include "LinkShellScreenShim.h"
#include <servers/bootstrap.h>
#include <bsm/libbsm.h>
#include <string.h>

typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surface;
  uint64_t token;
  uint32_t size;
  uint8_t metadata[1024];
} Frame;

mach_port_t ls_screen_listen(const char *name) {
  mach_port_t port = MACH_PORT_NULL;
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) != KERN_SUCCESS) return MACH_PORT_NULL;
  if (mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) {
    mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1); return MACH_PORT_NULL;
  }
  // A per-view capability, not a launchd job. Destroying the receive right unregisters it.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  kern_return_t result = bootstrap_register(bootstrap_port, (char *)name, port);
#pragma clang diagnostic pop
  mach_port_deallocate(mach_task_self(), port);
  if (result != KERN_SUCCESS) { mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1); return MACH_PORT_NULL; }
  return port;
}
mach_port_t ls_screen_connect(const char *name) {
  mach_port_t port = MACH_PORT_NULL;
  return bootstrap_look_up(bootstrap_port, name, &port) == KERN_SUCCESS ? port : MACH_PORT_NULL;
}
void ls_screen_close(mach_port_t port, int receiver) {
  if (!MACH_PORT_VALID(port)) return;
  if (receiver) mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
  else mach_port_deallocate(mach_task_self(), port);
}
int ls_screen_send(mach_port_t destination, mach_port_t surface, uint64_t token, const void *metadata, uint32_t size) {
  if (size > 1024 || !MACH_PORT_VALID(surface)) return 0;
  Frame frame = {0};
  frame.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  frame.header.msgh_size = sizeof(Frame);
  frame.header.msgh_remote_port = destination;
  frame.header.msgh_id = 1;
  frame.body.msgh_descriptor_count = 1;
  frame.surface.name = surface;
  frame.surface.disposition = MACH_MSG_TYPE_COPY_SEND;
  frame.surface.type = MACH_MSG_PORT_DESCRIPTOR;
  frame.token = token; frame.size = size;
  memcpy(frame.metadata, metadata, size);
  // Never block the decoder behind a paused or dead viewer.
  return mach_msg(&frame.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(Frame), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL) == MACH_MSG_SUCCESS;
}
int ls_screen_receive(mach_port_t port, pid_t child, mach_port_t *surface, uint64_t *token, void *metadata, uint32_t *size) {
  union { uint8_t bytes[sizeof(Frame) + MAX_TRAILER_SIZE]; Frame frame; } received = {0};
  mach_msg_return_t result = mach_msg(&received.frame.header,
    MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) | MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
    0, sizeof(received), port, 100, MACH_PORT_NULL);
  if (result != MACH_MSG_SUCCESS) return result == MACH_RCV_TIMED_OUT || result == MACH_RCV_TOO_LARGE ? 0 : -1;
  Frame *frame = &received.frame;
  mach_msg_audit_trailer_t *trailer = (void *)(received.bytes + ((frame->header.msgh_size + 3) & ~3));
  if (frame->header.msgh_size != sizeof(Frame) || !(frame->header.msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
      frame->body.msgh_descriptor_count != 1 || frame->surface.type != MACH_MSG_PORT_DESCRIPTOR ||
      frame->surface.disposition != MACH_MSG_TYPE_PORT_SEND || frame->size > 1024 ||
      trailer->msgh_trailer_size < sizeof(mach_msg_audit_trailer_t) || audit_token_to_pid(trailer->msgh_audit) != child) {
    mach_msg_destroy(&frame->header); return 0;
  }
  *surface = frame->surface.name; *token = frame->token; *size = frame->size;
  memcpy(metadata, frame->metadata, frame->size);
  frame->surface.name = MACH_PORT_NULL;
  mach_msg_destroy(&frame->header);
  return 1;
}
