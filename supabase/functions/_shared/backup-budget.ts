// Leave time for the SQL progress checkpoint and job requeue after Storage work.
export interface BackupWork {
  deadline: number;
  now: () => number;
}
export class BackupDeadline extends Error {
  constructor() {
    super("backup_deadline");
  }
}
export function backupTimeout(work?: BackupWork): number {
  const remaining = work ? work.deadline - work.now() : 10000;
  if (remaining <= 0) throw new BackupDeadline();
  return Math.max(1, Math.min(10000, remaining));
}
