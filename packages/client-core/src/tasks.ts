import type { BackgroundTask, SessionEvent } from "@linkshell/wire";
export type TaskRecords = Record<string, BackgroundTask>;
export const taskIsLive = (task: BackgroundTask): boolean => task.state === "running";
export function mergeTaskList(records: TaskRecords, list: BackgroundTask[]): TaskRecords {
  return list.reduce((current, task) => {
    const old = current[task.id];
    return old && (old.lastSeq ?? 0) >= (task.lastSeq ?? 0) ? current : { ...current, [task.id]: task };
  }, records);
}
export function applyTaskEvent(records: TaskRecords, event: SessionEvent): TaskRecords {
  return event.update.sessionUpdate === "ls_task" ? mergeTaskList(records, [{ ...event.update.task, lastSeq: event.seq }]) : records;
}
