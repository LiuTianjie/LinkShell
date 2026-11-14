export {
  InspectorWorkbench,
  type InspectorActiveTab,
  type InspectorWorkbenchProps,
} from "./InspectorWorkbench";
export {
  BottomTerminalDock,
  type BottomTerminalDockProps,
} from "./TerminalPanel";
export {
  StandaloneToolWorkspace,
  type StandaloneToolWorkspaceProps,
} from "./StandaloneToolWorkspace";
export {
  FileViewerTabPanel,
  type FileViewerTabPanelProps,
} from "./FileViewerTabPanel";
export {
  activateInspectorTab,
  closeActiveInspectorTab,
  closeInspectorTab,
  cycleInspectorTab,
  openInspectorGoToFile,
  requestCloseInspectorTab,
  inspectorTabsStore,
  openFileTabInInspector,
  openInspectorTab,
  openSubagentInInspector,
  requestOpenPortInInspector,
  resetInspectorTabsForTests,
  useInspectorTabs,
  type InspectorTabItem,
  type InspectorTabKind,
} from "./inspector-tabs-store";
