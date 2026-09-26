declare module '@vscode/windows-process-tree' {
  export interface WindowsProcessInfo {
    pid: number;
  }

  export function getProcessList(
    rootPid: number,
    callback: (processes: WindowsProcessInfo[] | undefined) => void,
  ): void;
}
